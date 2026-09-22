/**
 * knowfleet audit ledger + investigation dispatch — runs ONE audit pass
 * deterministically and keeps its verdict as versioned swamp data
 * (knowfleet task #453).
 *
 * `pass` surveys the ledger, decides what a single pass may do, opens or
 * adopts exactly one run, ensures it is being worked, completes it when
 * every target has a verdict, and opens investigations for the
 * machine-revisables. `notify` escalates a failed, stalled, or
 * needs-human pass to ntfy.
 *
 * Three boundaries are structural, not stylistic:
 *
 *  - **Never two drivers on one run.** A run that is already `running` is
 *    adopted, never duplicated, and while the auditor cron is active it
 *    owns verdict authorship — this model will not dispatch a second
 *    worker onto the same run (see _lib/cron.ts).
 *  - **Never a verdict from here.** The orchestrator does not classify.
 *    Verdicts come from a dispatched auditor profile writing through its
 *    own knowfleet session; this model has no audit_verdict_add path at
 *    all (see _lib/dispatch.ts).
 *  - **Never green without evidence.** An unreadable ledger, an
 *    unparseable manifest, a run that vanishes, or a completion that does
 *    not read back is a crash, not a pass (ported from #426).
 *
 * Reads are read-only SQLite; every mutation goes through the knowfleet
 * MCP server, which owns the ledger's invariants.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  alertAllowed,
  alertMessage,
  type AuditPass,
  type Batch,
  DEFAULT_DB,
  DEFAULT_HEARTBEAT,
  DEFAULT_MANIFEST,
  dispatchAllowed,
  heartbeatTarget,
  isInjected,
  lastLines,
  MAX_BATCHES_PER_DAY,
  parseBatchManifest,
  PASS_INSTANCE,
  type Plan,
  planPass,
  PROD_ALERT_URL,
  type RunRow,
  stallState,
  tallyVerdicts,
  type VerdictRow,
} from "./_lib/ledger.ts";
import {
  DEFAULT_WATERMARK,
  readRun,
  readSnapshot,
  runningInvestigations,
  runVerdicts,
} from "./_lib/query.ts";
import { cronOwner, jobsPath } from "./_lib/cron.ts";
import {
  auditorPrompt,
  dispatchAgent,
  investigatorPrompt,
} from "./_lib/dispatch.ts";
import { DEFAULT_SERVER, withKnowfleet } from "./_lib/mcp.ts";

const GlobalArgsSchema = z.object({
  dbPath: z.string().default(DEFAULT_DB).describe(
    "Absolute path to the knowfleet ledger. Any other value marks passes as injected test runs, which may not touch the production alert topic or heartbeat.",
  ),
  manifestPath: z.string().default(DEFAULT_MANIFEST).describe(
    "The #450 reconciliation batch manifest",
  ),
  watermarkPath: z.string().default(DEFAULT_WATERMARK).describe(
    "Daily candidate-audit watermark (cron 6baadbef2952)",
  ),
  nodePath: z.string().default("/opt/homebrew/bin/node").describe(
    "Absolute node binary (launchd PATH does not include Homebrew)",
  ),
  serverPath: z.string().default(DEFAULT_SERVER).describe(
    "knowfleet MCP server entrypoint",
  ),
  hermesPath: z.string().default("/Users/guru/.local/bin/hermes").describe(
    "hermes CLI used to dispatch the auditor/investigator profiles",
  ),
  workdir: z.string().default("/Users/guru/Code/active/knowfleet").describe(
    "Working directory for dispatched agents (matches the cron jobs)",
  ),
  auditorProfile: z.string().default("auditor"),
  investigatorProfile: z.string().default("investigator"),
  auditorCronId: z.string().default("883029b254e4").describe(
    "hermes cron job that owns verdict authorship; empty means the workflow owns it",
  ),
  investigatorCronId: z.string().default("63133383b02c").describe(
    "hermes cron job that owns remediation; empty means the workflow owns it",
  ),
  createdBy: z.string().default("swamp-audit-ledger").describe(
    "Provenance stamped on ledger writes made by the orchestrator",
  ),
  heartbeatPath: z.string().default(DEFAULT_HEARTBEAT).describe(
    "File touched after every full pass for the layer-1 heartbeat checker; empty disables",
  ),
  maxBatchesPerDay: z.number().int().positive().default(MAX_BATCHES_PER_DAY)
    .describe("Sol pacing: reconciliation batches opened per UTC day"),
  recentLimit: z.number().int().positive().default(50).describe(
    "How many recent runs to read for pacing and already-opened checks",
  ),
  timeoutMinutes: z.number().int().positive().default(90).describe(
    "Kill a dispatched agent after this long and record the pass as failed",
  ),
  mcpTimeoutSeconds: z.number().int().positive().default(60).describe(
    "Per-call timeout for the knowfleet MCP session",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PassArgsSchema = z.object({
  dispatch: z.boolean().default(false).describe(
    "Dispatch the auditor profile to author verdicts. Default false: while the auditor cron is active it owns authorship, and this pass only orchestrates. Ignored when the cron owns the run and it is not stalled.",
  ),
  open: z.boolean().default(true).describe(
    "Allow opening a new run when none is in flight",
  ),
  allowDaily: z.boolean().default(true).describe(
    "Allow opening the daily candidate audit",
  ),
  allowBatch: z.boolean().default(true).describe(
    "Allow opening the next #450 reconciliation batch",
  ),
  investigate: z.boolean().default(true).describe(
    "Open investigations for machine-revisable verdicts that lack one",
  ),
  maxInvestigations: z.number().int().min(0).default(5).describe(
    "Cap investigations opened per pass so a backlog does not flood the pool",
  ),
  dryRun: z.boolean().default(false).describe(
    "Plan and report without writing to the ledger. Never writes the heartbeat.",
  ),
  failOnError: z.boolean().default(true).describe(
    "Throw when the pass fails (after the record is persisted)",
  ),
});

const NotifyArgsSchema = z.object({
  url: z.string().default(PROD_ALERT_URL).describe(
    "ntfy topic URL; empty disables. Injected passes may not use the production topic.",
  ),
  priority: z.number().int().min(1).max(5).default(4).describe(
    "ntfy priority (tools.md: error=4)",
  ),
});

const VerdictCountsSchema = z.object({
  retain: z.number(),
  "machine-revisable": z.number(),
  "needs-human": z.number(),
  reject: z.number(),
  total: z.number(),
});

const PassSchema = z.object({
  ok: z.boolean(),
  crashed: z.boolean(),
  error: z.string().nullable(),
  action: z.string(),
  reason: z.string(),
  dbPath: z.string(),
  injected: z.boolean(),
  dryRun: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  runId: z.string().nullable(),
  triggerRef: z.string().nullable(),
  targets: z.number(),
  verdicts: VerdictCountsSchema,
  completed: z.boolean(),
  investigationsOpened: z.array(z.number()),
  dispatch: z.object({
    attempted: z.boolean(),
    allowed: z.boolean(),
    reason: z.string(),
  }),
  stall: z.object({
    stalled: z.boolean(),
    idleMinutes: z.number(),
    reason: z.string(),
  }).nullable(),
  batchesToday: z.number(),
  needsHuman: z.array(z.string()),
});

const AlertSchema = z.object({
  sent: z.boolean(),
  reason: z.string(),
  url: z.string(),
  title: z.string(),
  passStartedAt: z.string().nullable(),
  at: z.string(),
});

const ALERT_INSTANCE = "lastAlert";

interface Ctx {
  readonly globalArgs: GlobalArgs;
  readonly definition: { readonly name: string };
  readonly signal: AbortSignal;
  readonly logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  readResource(
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
  createFileWriter(
    specName: string,
    name: string,
  ): { writeText(text: string): Promise<{ name: string }> };
}

/** Load and parse the #450 batch manifest; a missing file is simply no batches. */
async function loadBatches(path: string): Promise<Batch[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return [];
  }
  // A malformed manifest throws — an ambiguous batch set must never be
  // silently narrowed into "nothing to reconcile".
  return parseBatchManifest(text);
}

export const model = {
  type: "@usefulish/audit-ledger",
  version: "2026.09.23.1",

  globalArguments: GlobalArgsSchema,

  // Runs after every method, including a failed pass, so the findings render.
  reports: ["@usefulish/audit-ledger-summary"],

  resources: {
    pass: {
      description:
        "One normalised audit pass — plan, run, verdict tally, completion, investigations",
      schema: PassSchema,
      lifetime: "infinite" as const,
      garbageCollection: 90,
    },
    alert: {
      description: "Outcome of the last escalation attempt",
      schema: AlertSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },

  files: {
    passLog: {
      description:
        "Pass narrative: plan, guards, dispatch output, ledger calls",
      contentType: "text/plain",
      lifetime: "30d" as const,
      garbageCollection: 30,
    },
  },

  methods: {
    pass: {
      description:
        "Run one knowfleet audit/investigation pass: survey, plan, open or adopt a run, ensure it is worked, complete it, and open investigations",
      arguments: PassArgsSchema,
      execute: async (
        args: z.infer<typeof PassArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = ctx.globalArgs;
        const startedAt = new Date().toISOString();
        const log: string[] = [];
        const say = (line: string) => {
          log.push(line);
        };
        const injected = isInjected(g.dbPath);
        if (injected) {
          ctx.logger.warning(
            "Injected ledger {path}: production alert topic and heartbeat are off-limits",
            { path: g.dbPath },
          );
        }

        let error: string | null = null;
        let crashed = false;
        let plan: Plan | null = null;
        let run: RunRow | null = null;
        let verdicts: VerdictRow[] = [];
        let completed = false;
        const investigationsOpened: number[] = [];
        let dispatchInfo = {
          attempted: false,
          allowed: false,
          reason: "not reached",
        };
        let stall: AuditPass["stall"] = null;
        let batchesToday = 0;
        let triggerRef: string | null = null;

        try {
          // ---- survey -------------------------------------------------
          const snapshot = await readSnapshot({
            db: g.dbPath,
            watermarkPath: g.watermarkPath,
            recentLimit: g.recentLimit,
            signal: ctx.signal,
          });
          const batches = await loadBatches(g.manifestPath);
          say(
            `survey: ${snapshot.runningRuns.length} running, ` +
              `${snapshot.dailyCandidates.length} daily candidate(s), ` +
              `${snapshot.verdictlessCandidates.length} verdict-less, ` +
              `${snapshot.dispatchableMr.length} machine-revisable awaiting ` +
              `investigation, ${snapshot.openInvestigations} open ` +
              `investigation(s), ${batches.length} batch(es) in the manifest`,
          );

          // ---- plan ---------------------------------------------------
          plan = planPass({
            snapshot,
            batches,
            now: startedAt,
            maxBatchesPerDay: g.maxBatchesPerDay,
            allowDaily: args.allowDaily,
            allowBatch: args.allowBatch && args.open,
          });
          batchesToday = plan.batchesToday;
          triggerRef = plan.triggerRef;
          say(`plan: ${plan.action} — ${plan.reason}`);
          ctx.logger.info("Pass plan: {action} — {reason}", {
            action: plan.action,
            reason: plan.reason,
          });

          const mcpOpts = {
            nodePath: g.nodePath,
            serverPath: g.serverPath,
            dbPath: g.dbPath,
            createdBy: g.createdBy,
            profile: "coordinator",
            timeoutMs: g.mcpTimeoutSeconds * 1000,
            signal: ctx.signal,
          };

          // ---- act ----------------------------------------------------
          if (plan.action === "adopt") {
            run = await readRun(g.dbPath, plan.runId!, ctx.signal);
            if (run === null) {
              throw new Error(
                `run ${plan.runId} vanished between survey and adopt`,
              );
            }
          } else if (
            plan.action === "open-daily" || plan.action === "open-batch"
          ) {
            if (!args.open) {
              say("open: refused — opening disabled for this pass");
            } else if (args.dryRun) {
              say(
                `open: DRY RUN — would create "${plan.triggerRef}" with ` +
                  `${plan.targets.length} target(s)`,
              );
            } else {
              const created = await withKnowfleet(
                mcpOpts,
                (mcp) =>
                  mcp.call<{ id?: string }>("audit_run_create", {
                    trigger_ref: plan!.triggerRef,
                    auditor_profile: g.auditorProfile,
                    session_id: `swamp-audit-ledger-${startedAt.slice(0, 10)}`,
                    targets: plan!.targets.map((id) => ({ record_id: id })),
                  }),
              );
              const newId = typeof created?.id === "string" ? created.id : null;
              if (!newId) {
                throw new Error(
                  `audit_run_create returned no run id for "${plan.triggerRef}"`,
                );
              }
              // Read back every durable write.
              run = await readRun(g.dbPath, newId, ctx.signal);
              if (run === null) {
                throw new Error(
                  `created run ${newId} does not read back from the ledger`,
                );
              }
              if (run.targets !== plan.targets.length) {
                throw new Error(
                  `created run ${newId} has ${run.targets} target(s), ` +
                    `expected ${plan.targets.length}`,
                );
              }
              say(
                `open: created ${newId} with ${run.targets} target(s) — ` +
                  `"${plan.triggerRef}"`,
              );
            }
          }

          // ---- drive --------------------------------------------------
          if (run !== null) {
            verdicts = await runVerdicts(g.dbPath, run.id, ctx.signal);
            stall = stallState(run, new Date().toISOString());
            say(
              `run ${run.id.slice(0, 8)}: ${verdicts.length}/${run.targets} ` +
                `verdicts — ${stall.reason}`,
            );

            const owner = g.auditorCronId.trim() === ""
              ? {
                owned: false,
                reason: "no auditor cron configured — workflow owns the loop",
                jobId: "",
                lastRunAt: null,
                nextRunAt: null,
              }
              : await cronOwner(
                jobsPath(g.auditorProfile),
                g.auditorCronId,
              );
            say(`owner: ${owner.reason}`);

            const gate = dispatchAllowed({
              cronOwned: owner.owned,
              stalled: stall.stalled,
              dispatch: args.dispatch && !args.dryRun,
            });
            dispatchInfo = { attempted: false, ...gate };

            const needsWork = verdicts.length < run.targets;
            if (gate.allowed && needsWork) {
              dispatchInfo.attempted = true;
              say(
                `dispatch: auditor on ${run.id.slice(0, 8)} — ${gate.reason}`,
              );
              ctx.logger.info("Dispatching auditor for {run}", {
                run: run.id,
              });
              const res = await dispatchAgent({
                hermesPath: g.hermesPath,
                profile: g.auditorProfile,
                prompt: auditorPrompt(run.id),
                workdir: g.workdir,
                timeoutMs: g.timeoutMinutes * 60_000,
                signal: ctx.signal,
              });
              say(
                `dispatch: exit ${res.exitCode}` +
                  (res.timedOut ? " (timed out)" : "") +
                  `\n--- auditor stdout ---\n${res.stdout}` +
                  `\n--- auditor stderr ---\n${res.stderr}`,
              );
              if (!res.ok) {
                throw new Error(
                  `auditor dispatch failed (exit ${res.exitCode}${
                    res.timedOut ? ", timed out" : ""
                  }): ${lastLines(res.stderr, 3) || "no stderr"}`,
                );
              }
              // Re-read: the dispatch is only credible through the ledger.
              run = await readRun(g.dbPath, run.id, ctx.signal) ?? run;
              verdicts = await runVerdicts(g.dbPath, run.id, ctx.signal);
              say(`after dispatch: ${verdicts.length}/${run.targets} verdicts`);
            } else if (needsWork) {
              say(`dispatch: skipped — ${gate.reason}`);
            } else {
              dispatchInfo.reason = "every target already has a verdict";
              say("dispatch: not needed — every target has a verdict");
            }

            // ---- close ------------------------------------------------
            if (
              verdicts.length >= run.targets && run.targets > 0 &&
              run.status === "running"
            ) {
              if (args.dryRun) {
                say(`close: DRY RUN — would complete ${run.id.slice(0, 8)}`);
              } else {
                await withKnowfleet(
                  mcpOpts,
                  (mcp) => mcp.call("audit_run_complete", { id: run!.id }),
                );
                const after = await readRun(g.dbPath, run.id, ctx.signal);
                if (after === null || after.status === "running") {
                  throw new Error(
                    `audit_run_complete did not take effect for ${run.id}`,
                  );
                }
                completed = true;
                run = after;
                say(`close: completed ${run.id.slice(0, 8)} (${run.status})`);
              }
            }
          }

          // ---- investigate --------------------------------------------
          if (args.investigate && args.maxInvestigations > 0) {
            const invOwner = g.investigatorCronId.trim() === ""
              ? { owned: false, reason: "no investigator cron configured" }
              : await cronOwner(
                jobsPath(g.investigatorProfile),
                g.investigatorCronId,
                "remediation",
              );
            // Opening an investigation is bookkeeping, not remediation, so
            // it is safe alongside the investigator cron — the cron's own
            // probe only ever surfaces investigations that already exist,
            // and investigation_start is refused for a non-machine-revisable
            // verdict. What we never do here is REMEDIATE.
            const fresh = await readSnapshot({
              db: g.dbPath,
              watermarkPath: g.watermarkPath,
              recentLimit: g.recentLimit,
              signal: ctx.signal,
            });
            const todo = fresh.dispatchableMr.slice(0, args.maxInvestigations);
            say(
              `investigate: ${fresh.dispatchableMr.length} machine-revisable ` +
                `verdict(s) without an investigation; opening ` +
                `${todo.length} (cap ${args.maxInvestigations}); ` +
                `${invOwner.reason}`,
            );
            for (const v of todo) {
              if (args.dryRun) {
                say(
                  `investigate: DRY RUN — would start on verdict ${v.id} ` +
                    `(record ${v.recordId?.slice(0, 8)})`,
                );
                continue;
              }
              const started = await withKnowfleet(
                mcpOpts,
                (mcp) =>
                  mcp.call<{ id?: number }>("investigation_start", {
                    originating_verdict_id: v.id,
                    investigator_profile: g.investigatorProfile,
                    task_ref: "swamp-audit-ledger",
                  }),
              );
              if (typeof started?.id === "number") {
                investigationsOpened.push(started.id);
                say(
                  `investigate: opened #${started.id} on verdict ${v.id} ` +
                    `(record ${v.recordId?.slice(0, 8)})`,
                );
              } else {
                say(
                  `investigate: verdict ${v.id} returned no investigation id`,
                );
              }
            }

            // Remediation is the investigator's, and while its cron is
            // enabled that cron owns it — same no-double-run guard as the
            // auditor. Pause the cron and this pass works the FIFO instead,
            // so handing the loop over never strands open investigations.
            const invGate = dispatchAllowed({
              cronOwned: invOwner.owned,
              stalled: false,
              dispatch: args.dispatch && !args.dryRun,
              role: "remediation",
            });
            if (invGate.allowed) {
              const open = await runningInvestigations(g.dbPath, ctx.signal);
              const oldest = open[0];
              if (oldest) {
                say(
                  `remediate: investigator on #${oldest.id} ` +
                    `(record ${oldest.recordId?.slice(0, 8)}) — ` +
                    `${invGate.reason}`,
                );
                const res = await dispatchAgent({
                  hermesPath: g.hermesPath,
                  profile: g.investigatorProfile,
                  prompt: investigatorPrompt(
                    oldest.id,
                    oldest.recordId ?? "unknown",
                  ),
                  workdir: g.workdir,
                  timeoutMs: g.timeoutMinutes * 60_000,
                  signal: ctx.signal,
                });
                say(
                  `remediate: exit ${res.exitCode}` +
                    (res.timedOut ? " (timed out)" : "") +
                    `\n--- investigator stdout ---\n${res.stdout}` +
                    `\n--- investigator stderr ---\n${res.stderr}`,
                );
                if (!res.ok) {
                  throw new Error(
                    `investigator dispatch failed (exit ${res.exitCode}${
                      res.timedOut ? ", timed out" : ""
                    }): ${lastLines(res.stderr, 3) || "no stderr"}`,
                  );
                }
              } else {
                say("remediate: no running investigation to work");
              }
            } else {
              say(`remediate: skipped — ${invGate.reason}`);
            }
          }
        } catch (e) {
          crashed = true;
          error = e instanceof Error ? e.message : String(e);
          say(`ERROR: ${error}`);
          ctx.logger.warning("Pass failed: {error}", { error });
        }

        // ---- normalise ------------------------------------------------
        const tally = tallyVerdicts(verdicts);
        const needsHuman = verdicts
          .filter((v) => v.verdict === "needs-human")
          .map((v) => (v.recordId ?? "unknown").slice(0, 8));

        // A pass is green only on evidence: it crashed nowhere, it reached a
        // decision, and if it claimed a run that run actually exists.
        const reachedDecision = plan !== null;
        const runConsistent = plan === null || plan.action === "idle" ||
          !args.open || args.dryRun || run !== null;
        const ok = !crashed && reachedDecision && runConsistent;
        if (!crashed && !reachedDecision) {
          error = "pass produced no plan";
        } else if (!crashed && !runConsistent) {
          error = `plan said ${plan?.action} but no run was in hand`;
        }

        const pass: AuditPass = {
          ok,
          crashed,
          error,
          action: plan?.action ?? "idle",
          reason: plan?.reason ?? (error ?? "no plan"),
          dbPath: g.dbPath,
          injected,
          dryRun: args.dryRun,
          startedAt,
          finishedAt: new Date().toISOString(),
          runId: run?.id ?? plan?.runId ?? null,
          triggerRef,
          targets: run?.targets ?? plan?.targets.length ?? 0,
          verdicts: tally,
          completed,
          investigationsOpened,
          dispatch: dispatchInfo,
          stall,
          batchesToday,
          needsHuman,
        };

        const handles = [
          await ctx.writeResource(
            "pass",
            PASS_INSTANCE,
            pass as unknown as Record<string, unknown>,
          ),
          await ctx.createFileWriter("passLog", "pass-log").writeText(
            `# audit-ledger pass ${startedAt}\n\n${log.join("\n")}\n`,
          ),
        ];

        // Heartbeat = "the pass ran to a decision", idle or busy. A failure
        // escalates separately via notify; the checker catches the job dying.
        const hb = heartbeatTarget(pass, g.heartbeatPath);
        if (hb.path !== null && ok) {
          const dir = hb.path.slice(0, hb.path.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(
            hb.path,
            `${pass.finishedAt} ok=${pass.ok} action=${pass.action}\n`,
          );
        }
        ctx.logger.info("Heartbeat: {reason}", {
          reason: ok ? hb.reason : "pass failed — heartbeat not written",
        });

        ctx.logger.info(
          "Audit pass ({action}): {ok} — run {run}, {verdicts}/{targets} verdicts, {inv} investigation(s)",
          {
            action: pass.action,
            ok: pass.ok ? "OK" : "FAILED",
            run: pass.runId?.slice(0, 8) ?? "none",
            verdicts: tally.total,
            targets: pass.targets,
            inv: investigationsOpened.length,
          },
        );

        if (args.failOnError && !pass.ok) {
          const msg = alertMessage(pass);
          throw new Error(
            `${msg.title}\n${msg.body}\n` +
              `Full pass: swamp data get ${ctx.definition.name} ${PASS_INSTANCE} --json`,
          );
        }
        return { dataHandles: handles };
      },
    },

    notify: {
      description:
        "Escalate the latest pass to ntfy when it failed, stalled, or found needs-human verdicts (a clean pass is silent; liveness is the heartbeat's job)",
      arguments: NotifyArgsSchema,
      execute: async (
        args: z.infer<typeof NotifyArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const stored = await ctx.readResource(PASS_INSTANCE);
        const at = new Date().toISOString();
        const record = async (a: z.infer<typeof AlertSchema>) => ({
          dataHandles: [await ctx.writeResource("alert", ALERT_INSTANCE, a)],
        });

        if (stored === null) {
          throw new Error(
            `No audit pass recorded for ${ctx.definition.name}; nothing to escalate`,
          );
        }
        const pass = stored as unknown as AuditPass;
        const base = {
          url: args.url,
          passStartedAt: pass.startedAt ?? null,
          at,
        };

        const worth = !pass.ok || pass.stall?.stalled === true ||
          pass.needsHuman.length > 0;
        if (!worth) {
          return await record({
            ...base,
            sent: false,
            reason: "latest pass was clean",
            title: "",
          });
        }
        const gate = alertAllowed(pass, args.url);
        const msg = alertMessage(pass);
        if (!gate.allowed) {
          ctx.logger.warning("Alert not sent: {reason}", {
            reason: gate.reason,
          });
          return await record({
            ...base,
            sent: false,
            reason: gate.reason,
            title: msg.title,
          });
        }
        // Delivery is checked, never swallowed (knowfleet 709ae6c7): a dead
        // ntfy fails this step instead of looking like a sent alert.
        let status: string;
        try {
          const r = await fetch(args.url, {
            method: "POST",
            headers: {
              Title: msg.title,
              Priority: String(args.priority),
              Tags: "rotating_light,knowfleet",
            },
            body: msg.body,
            signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
          });
          await r.body?.cancel();
          status = r.ok ? "delivered" : `ntfy HTTP ${r.status}`;
        } catch (e) {
          status = `ntfy unreachable: ${e instanceof Error ? e.message : e}`;
        }
        const handles = await record({
          ...base,
          sent: status === "delivered",
          reason: status,
          title: msg.title,
        });
        if (status !== "delivered") {
          throw new Error(
            `ALERT DELIVERY FAILED: ${status} (${args.url}) — alert was: ${msg.title}`,
          );
        }
        ctx.logger.info("Alert delivered: {title}", { title: msg.title });
        return handles;
      },
    },
  },
};

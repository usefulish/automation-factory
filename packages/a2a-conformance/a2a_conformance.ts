/**
 * A2A conformance gate — runs the fleet's A2A v1.0 conformance suite
 * (a2a-edge `scripts/conformance.mjs`, knowfleet task #353) and keeps its
 * verdict as versioned swamp data.
 *
 * `run` executes the suite against the kimchi A2A peers, persists the
 * normalised report as the `run` resource, writes the layer-1 heartbeat
 * (full runs only), and fails when the gate fails. `notify` escalates the
 * latest failed run to ntfy. The suite itself owns every probe; this model
 * owns scheduling, history, and escalation (knowfleet task #426).
 *
 * No secrets pass through here: the suite reads the fleet token from the
 * Keychain itself and hands it to a2a-cli via env.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  alertAllowed,
  alertMessage,
  buildSuiteArgs,
  type ConformanceRun,
  DEFAULT_HEARTBEAT,
  DEFAULT_SUITE,
  heartbeatTarget,
  isInjected,
  lastLines,
  parseOnly,
  PROD_ALERT_URL,
  RUN_INSTANCE,
  summarize,
} from "./_lib/summary.ts";

const GlobalArgsSchema = z.object({
  suitePath: z.string().default(DEFAULT_SUITE).describe(
    "Absolute path to conformance.mjs. Any other value marks runs as injected test runs, which may not touch the production alert topic or heartbeat.",
  ),
  nodePath: z.string().default("/opt/homebrew/bin/node").describe(
    "Absolute node binary (launchd PATH does not include Homebrew)",
  ),
  heartbeatPath: z.string().default(DEFAULT_HEARTBEAT).describe(
    "File touched after every full run for the layer-1 heartbeat checker; empty disables",
  ),
  timeoutMinutes: z.number().int().positive().default(45).describe(
    "Kill the suite after this long and record the run as crashed",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RunArgsSchema = z.object({
  only: z.string().default("").describe(
    "Comma-separated target-name prefixes (e.g. codex,claude); empty runs every target",
  ),
  strict: z.boolean().default(true).describe(
    "Gate on reference peers (pi, librarian) too, not just the edges",
  ),
  skipSlow: z.boolean().default(false).describe("Skip the cancel probe"),
  failOnError: z.boolean().default(true).describe(
    "Throw when the gate fails (after the report is persisted)",
  ),
});

const NotifyArgsSchema = z.object({
  url: z.string().default(PROD_ALERT_URL).describe(
    "ntfy topic URL; empty disables. Injected runs may not use the production topic.",
  ),
  priority: z.number().int().min(1).max(5).default(4).describe(
    "ntfy priority (tools.md: error=4)",
  ),
});

const ProbeSchema = z.object({
  probe: z.string(),
  status: z.string(),
  detail: z.string(),
}).passthrough();

const TargetSchema = z.object({
  name: z.string(),
  kind: z.string(),
  url: z.string(),
  passed: z.number(),
  failed: z.number(),
  inconclusive: z.number(),
  ms: z.number(),
  results: z.array(ProbeSchema),
}).passthrough();

const RunSchema = z.object({
  ok: z.boolean(),
  crashed: z.boolean(),
  error: z.string().nullable(),
  gate: z.string(),
  strict: z.boolean(),
  only: z.array(z.string()),
  skipSlow: z.boolean(),
  exitCode: z.number(),
  timedOut: z.boolean(),
  suitePath: z.string(),
  injected: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  cliCommit: z.string().nullable(),
  totals: z.object({
    targets: z.number(),
    failedTargets: z.number(),
    probes: z.number(),
    failedProbes: z.number(),
    inconclusive: z.number(),
  }),
  targets: z.array(TargetSchema),
});

const AlertSchema = z.object({
  sent: z.boolean(),
  reason: z.string(),
  url: z.string(),
  title: z.string(),
  runStartedAt: z.string().nullable(),
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

/** Run the suite; never throws for a non-zero exit (that is data). */
async function runSuite(
  g: GlobalArgs,
  args: string[],
  signal: AbortSignal,
): Promise<
  { code: number; stdout: string; stderr: string; timedOut: boolean }
> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, g.timeoutMinutes * 60_000);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const out = await new Deno.Command(g.nodePath, {
      args: [g.suitePath, ...args],
      // The suite shells out to /usr/bin/security and the pinned a2a-cli
      // build script; launchd's PATH lacks Homebrew.
      env: {
        PATH: `/opt/homebrew/bin:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
      timedOut,
    };
  } catch (e) {
    return {
      code: timedOut ? 124 : 127,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

export const model = {
  type: "@usefulish/a2a-conformance",
  version: "2026.09.22.1",

  globalArguments: GlobalArgsSchema,

  // Runs after every method, including a failed gate, so the findings render.
  reports: ["@usefulish/a2a-conformance-summary"],

  resources: {
    run: {
      description:
        "Normalised A2A conformance run — gate verdict, per-target and per-probe results",
      schema: RunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 90,
    },
    alert: {
      description: "Outcome of the last escalation attempt for a failed run",
      schema: AlertSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },

  files: {
    suiteLog: {
      description:
        "Suite stdout and stderr (per-target lines, non-pass probes)",
      contentType: "text/plain",
      lifetime: "30d" as const,
      garbageCollection: 30,
    },
  },

  methods: {
    run: {
      description:
        "Run the A2A v1.0 conformance suite against the kimchi A2A peers and gate on the result",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = ctx.globalArgs;
        const only = parseOnly(args.only);
        const tmp = await Deno.makeTempDir({ prefix: "a2a-conformance-" });
        const jsonPath = `${tmp}/report.json`;
        const startedAt = new Date().toISOString();
        if (isInjected(g.suitePath)) {
          ctx.logger.warning(
            "Injected suite {path}: production alert topic and heartbeat are off-limits",
            { path: g.suitePath },
          );
        }

        const res = await runSuite(
          g,
          buildSuiteArgs({
            only,
            strict: args.strict,
            skipSlow: args.skipSlow,
            jsonPath,
          }),
          ctx.signal,
        );
        const report = await readJson(jsonPath);
        await Deno.remove(tmp, { recursive: true }).catch(() => {});

        const run: ConformanceRun = summarize({
          report,
          exitCode: res.code,
          timedOut: res.timedOut,
          stderr: res.stderr,
          strict: args.strict,
          only,
          skipSlow: args.skipSlow,
          suitePath: g.suitePath,
          startedAt,
          finishedAt: new Date().toISOString(),
        });

        const handles = [
          await ctx.writeResource(
            "run",
            RUN_INSTANCE,
            run as unknown as Record<string, unknown>,
          ),
          await ctx.createFileWriter("suiteLog", "suite-log").writeText(
            `$ node ${g.suitePath} ${
              buildSuiteArgs({
                only,
                strict: args.strict,
                skipSlow: args.skipSlow,
                jsonPath: "<tmp>",
              }).join(" ")
            }\n# exit ${res.code}${res.timedOut ? " (timed out)" : ""}\n\n` +
              `## stdout\n${res.stdout}\n## stderr\n${res.stderr}`,
          ),
        ];

        // Heartbeat = "the job ran to a verdict", pass or fail; a failure
        // escalates separately via notify. The checker catches the job dying.
        const hb = heartbeatTarget(run, g.heartbeatPath);
        if (hb.path !== null) {
          const dir = hb.path.slice(0, hb.path.lastIndexOf("/"));
          await Deno.mkdir(dir, { recursive: true });
          await Deno.writeTextFile(
            hb.path,
            `${run.finishedAt} ok=${run.ok} gate=${run.gate}\n`,
          );
        }
        ctx.logger.info("Heartbeat: {reason}", { reason: hb.reason });

        ctx.logger.info(
          "A2A conformance ({gate}): {ok} — {targets} target(s), {failed} failed probe(s), {inc} inconclusive",
          {
            gate: run.gate,
            ok: run.ok ? "PASS" : "FAIL",
            targets: run.totals.targets,
            failed: run.totals.failedProbes,
            inc: run.totals.inconclusive,
          },
        );

        if (args.failOnError && !run.ok) {
          const msg = alertMessage(run);
          throw new Error(
            `${msg.title}\n${msg.body}\n` +
              `Full report: swamp data get ${ctx.definition.name} ${RUN_INSTANCE} --json` +
              (run.crashed ? `\nstderr: ${lastLines(res.stderr, 5)}` : ""),
          );
        }
        return { dataHandles: handles };
      },
    },

    notify: {
      description:
        "Escalate the latest run to ntfy if it failed (success is silent; liveness is the heartbeat's job)",
      arguments: NotifyArgsSchema,
      execute: async (
        args: z.infer<typeof NotifyArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const stored = await ctx.readResource(RUN_INSTANCE);
        const at = new Date().toISOString();
        const record = async (
          a: z.infer<typeof AlertSchema>,
        ) => ({
          dataHandles: [await ctx.writeResource("alert", ALERT_INSTANCE, a)],
        });

        if (stored === null) {
          // No run on record is itself alarming if we were asked to notify.
          throw new Error(
            `No conformance run recorded for ${ctx.definition.name}; nothing to escalate`,
          );
        }
        const run = stored as unknown as ConformanceRun;
        const base = {
          url: args.url,
          runStartedAt: run.startedAt ?? null,
          at,
        };
        if (run.ok) {
          return await record({
            ...base,
            sent: false,
            reason: "latest run passed",
            title: "",
          });
        }
        const gate = alertAllowed(run, args.url);
        const msg = alertMessage(run);
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
              Tags: "rotating_light,a2a",
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

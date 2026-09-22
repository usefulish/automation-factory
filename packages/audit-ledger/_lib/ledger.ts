/**
 * Pure helpers for the knowfleet audit-ledger model: pass planning, Sol
 * pacing, #450 batch-manifest parsing, verdict tallies, stall detection,
 * alert text, and the production-surface guards.
 *
 * Everything here is side-effect free so it can be unit-tested without the
 * ledger, the MCP server, hermes, or ntfy (see ../audit_ledger_test.ts).
 *
 * The load-bearing rule lives in `planPass`: a run that is already
 * `running` is ADOPTED, never duplicated, and no new run is opened while
 * one is in flight. That single ordering is what keeps the workflow from
 * double-running a batch the cron polls are already working (knowfleet
 * task #453) and generalises lesson 14583002 — any running run counts, not
 * just the daily ones.
 *
 * @module
 */

/** The ledger this model exists to drive. Anything else is an injected stub. */
export const DEFAULT_DB = "/Users/guru/Code/active/knowfleet/data/knowfleet.db";

/** Production escalation topic (tools.md "Notifications": error -> alerts). */
export const PROD_ALERT_URL = "https://ntfy.oryx-herring.ts.net/alerts";

/**
 * Directory the layer-1 heartbeat checker watches (knowfleet task #146,
 * design 4aa5a381). A heartbeat here tells that checker the job is alive, so
 * an injected run must never write one (knowfleet #412, ported from #426).
 */
export const PROD_HEARTBEAT_DIR =
  "/Users/guru/Scripts/network-status/machines/kimchi/heartbeats/";

export const DEFAULT_HEARTBEAT = PROD_HEARTBEAT_DIR + "audit-ledger.heartbeat";

/** Default #450 reconciliation batch manifest. */
export const DEFAULT_MANIFEST =
  "/Users/guru/Code/a2a-workspace/reconciliation-450/manifest.md";

/** Every pass overwrites this instance; its versions are the history. */
export const PASS_INSTANCE = "lastPass";

/** The four verdicts the audit-loop contract allows. */
export const VERDICTS = [
  "retain",
  "machine-revisable",
  "needs-human",
  "reject",
] as const;
export type Verdict = typeof VERDICTS[number];

/** Sol pacing: reconciliation batches opened per day (knowfleet #450). */
export const MAX_BATCHES_PER_DAY = 2;

/** The auditor cron's cadence; a run idle for 3 ticks is stalled. */
export const CRON_CADENCE_MINUTES = 30;
export const STALL_TICKS = 3;

/** One audit run as the ledger holds it. */
export interface RunRow {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed" | "partial";
  triggerRef: string;
  auditorProfile: string | null;
  loop: number;
  targets: number;
  verdicts: number;
  lastVerdictAt: string | null;
}

/** One verdict row (the tally source). */
export interface VerdictRow {
  id: number;
  runId: string;
  targetId: number;
  recordId: string | null;
  verdict: Verdict;
  finding: string | null;
  createdAt: string;
  hasInvestigation: boolean;
}

/** A #450 reconciliation batch as the manifest declares it. */
export interface Batch {
  /** 1-based batch number, e.g. 2 for B2. */
  number: number;
  /** Total batches declared by the manifest (the "/6"). */
  of: number;
  /** 8-char record id prefixes, in manifest order. */
  records: string[];
}

/**
 * The ledger state one pass reads before it decides anything.
 *
 * `dailyCandidates` and `verdictlessCandidates` are deliberately different
 * sets: the daily run audits what is NEW since the watermark (cron
 * 6baadbef2952's rule, `created_at > watermark`), while the #450
 * reconciliation closes the HISTORICAL gap (candidates carrying no verdict
 * at all). Conflating them would make the daily run re-audit the backlog.
 */
export interface LedgerSnapshot {
  at: string;
  runningRuns: RunRow[];
  recentRuns: RunRow[];
  /** status='candidate' AND created_at > watermark — the daily run's targets. */
  dailyCandidates: string[];
  /** status='candidate' AND no verdict — the #450 reconciliation gap. */
  verdictlessCandidates: string[];
  openInvestigations: number;
  dispatchableMr: VerdictRow[];
}

export type PassAction =
  | "adopt"
  | "open-daily"
  | "open-batch"
  | "idle";

/** What one pass decided to do, and why. */
export interface Plan {
  action: PassAction;
  reason: string;
  /** The run to work, when adopting. */
  runId: string | null;
  /** The batch to open, when opening one. */
  batch: Batch | null;
  /** Targets for a run this pass would open. */
  targets: string[];
  /** trigger_ref for a run this pass would open. */
  triggerRef: string | null;
  /** Batches already opened today, against MAX_BATCHES_PER_DAY. */
  batchesToday: number;
}

/** UTC calendar date (YYYY-MM-DD) of an ISO timestamp. */
export function utcDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** trigger_ref the daily run carries, per cron 6baadbef2952. */
export function dailyTriggerRef(date: string): string {
  return `daily candidate audit ${date}`;
}

/** trigger_ref a reconciliation batch carries, per the #450 manifest. */
export function batchTriggerRef(b: Batch): string {
  return `reconciliation batch ${b.number}/${b.of} (B${b.number}, ` +
    `${b.records.length} records) — #450 verdict-less candidates`;
}

/**
 * Parse the #450 batch manifest. Recognises lines shaped
 * `B2 [30]: e3e926e3 e71ec129 ...` and ignores everything else, so prose
 * edits to the manifest cannot silently change the batch set.
 */
export function parseBatchManifest(md: string): Batch[] {
  const batches: Batch[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^B(\d+)\s*\[(\d+)\]\s*:\s*(.+)$/);
    if (!m) continue;
    const records = m[3].trim().split(/[\s,]+/).filter(Boolean);
    const declared = Number(m[2]);
    if (records.length !== declared) {
      throw new Error(
        `batch manifest B${m[1]}: declares ${declared} records but lists ` +
          `${records.length} — refusing an ambiguous batch`,
      );
    }
    batches.push({ number: Number(m[1]), of: 0, records });
  }
  const of = batches.length;
  return batches.map((b) => ({ ...b, of }));
}

/** True when a run's trigger_ref is the given reconciliation batch. */
export function isBatchRun(run: RunRow, n: number, of: number): boolean {
  return run.triggerRef.includes(`reconciliation batch ${n}/${of}`);
}

/** True when a run is the daily candidate audit for a UTC date. */
export function isDailyRun(run: RunRow, date: string): boolean {
  return run.triggerRef.includes(dailyTriggerRef(date));
}

/** Reconciliation batches opened on a given UTC date (Sol pacing). */
export function batchesOpenedOn(runs: RunRow[], date: string): number {
  return runs.filter((r) =>
    /reconciliation batch \d+\/\d+/.test(r.triggerRef) &&
    utcDate(r.startedAt) === date
  ).length;
}

/**
 * Decide what this pass does. Ordering is the whole contract:
 *
 * 1. Any run still `running` is adopted — never duplicated, and nothing new
 *    is opened while it is in flight. This is the no-double-run guard, and
 *    it covers non-daily runs too (lesson 14583002).
 * 2. The daily candidate audit, when it is due and has candidates.
 * 3. The next unopened #450 batch, if Sol pacing allows another today.
 * 4. Otherwise idle — a caught-up ledger is a real outcome, not a failure.
 */
export function planPass(input: {
  snapshot: LedgerSnapshot;
  batches: Batch[];
  now: string;
  maxBatchesPerDay?: number;
  allowDaily?: boolean;
  allowBatch?: boolean;
}): Plan {
  const {
    snapshot,
    batches,
    now,
    maxBatchesPerDay = MAX_BATCHES_PER_DAY,
    allowDaily = true,
    allowBatch = true,
  } = input;
  const today = utcDate(now);
  const batchesToday = batchesOpenedOn(snapshot.recentRuns, today);
  const base = { batch: null, targets: [], triggerRef: null, batchesToday };

  // (1) Adopt, never duplicate.
  if (snapshot.runningRuns.length > 0) {
    const oldest = [...snapshot.runningRuns].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt)
    )[0];
    return {
      ...base,
      action: "adopt",
      reason: `run ${oldest.id.slice(0, 8)} is still running ` +
        `(${oldest.verdicts}/${oldest.targets} verdicts) — adopting it; ` +
        "no new run is opened while one is in flight",
      runId: oldest.id,
    };
  }

  // (2) The daily candidate audit.
  const dailyDone = snapshot.recentRuns.some((r) => isDailyRun(r, today));
  if (allowDaily && !dailyDone && snapshot.dailyCandidates.length > 0) {
    return {
      ...base,
      action: "open-daily",
      reason: `no daily run for ${today}; ` +
        `${snapshot.dailyCandidates.length} candidate(s) since the watermark`,
      runId: null,
      targets: snapshot.dailyCandidates,
      triggerRef: dailyTriggerRef(today),
    };
  }

  // (3) The next unopened #450 batch that still has work, Sol pacing
  // permitting. A batch whose records all acquired verdicts by some other
  // route is skipped rather than parking the reconciliation on it.
  const unopened = unopenedBatches(batches, snapshot.recentRuns);
  if (allowBatch && unopened.length > 0) {
    // Drop ids that acquired a verdict since the manifest was prepped.
    const verdictless = new Set(
      snapshot.verdictlessCandidates.map((id) => id.slice(0, 8)),
    );
    const skipped: number[] = [];
    for (const b of unopened) {
      const targets = b.records.filter((id) => verdictless.has(id.slice(0, 8)));
      if (targets.length === 0) {
        skipped.push(b.number);
        continue;
      }
      if (batchesToday >= maxBatchesPerDay) {
        return {
          ...base,
          action: "idle",
          reason: `Sol pacing: ${batchesToday}/${maxBatchesPerDay} ` +
            `reconciliation batches already opened on ${today} — ` +
            `B${b.number} waits for tomorrow`,
          runId: null,
        };
      }
      const note = skipped.length
        ? ` (B${skipped.join(", B")} already fully verdicted)`
        : "";
      return {
        action: "open-batch",
        reason: `opening B${b.number} (${targets.length} of ` +
          `${b.records.length} still verdict-less)${note}; ` +
          `${batchesToday}/${maxBatchesPerDay} batches opened today`,
        runId: null,
        batch: b,
        targets,
        triggerRef: batchTriggerRef({ ...b, records: targets }),
        batchesToday,
      };
    }
    return {
      ...base,
      action: "idle",
      reason: `every unopened batch (B${skipped.join(", B")}) already ` +
        "carries verdicts — nothing to open",
      runId: null,
    };
  }

  return {
    ...base,
    action: "idle",
    reason: unopened.length > 0
      ? "batch opening disabled for this pass"
      : "no running run, daily audit satisfied, and every #450 batch opened",
    runId: null,
  };
}

/** Batches with no run in the ledger, lowest number first. */
export function unopenedBatches(batches: Batch[], runs: RunRow[]): Batch[] {
  return [...batches]
    .sort((x, y) => x.number - y.number)
    .filter((b) => !runs.some((r) => isBatchRun(r, b.number, b.of)));
}

/** The lowest-numbered batch with no run in the ledger. */
export function nextUnopenedBatch(
  batches: Batch[],
  runs: RunRow[],
): Batch | null {
  return unopenedBatches(batches, runs)[0] ?? null;
}

/** Count verdicts by kind. Unknown kinds are counted but never silently. */
export function tallyVerdicts(
  verdicts: Pick<VerdictRow, "verdict">[],
): Record<Verdict, number> & { total: number } {
  const out = {
    retain: 0,
    "machine-revisable": 0,
    "needs-human": 0,
    reject: 0,
    total: verdicts.length,
  };
  for (const v of verdicts) {
    if (v.verdict in out) out[v.verdict] += 1;
  }
  return out;
}

/**
 * Is an adopted run making progress? A run whose verdict count has not moved
 * for `ticks` auditor-cron cadences is stalled — that escalates, it does not
 * silently trigger a second driver.
 */
export function stallState(
  run: RunRow,
  now: string,
  cadenceMinutes = CRON_CADENCE_MINUTES,
  ticks = STALL_TICKS,
): { stalled: boolean; idleMinutes: number; reason: string } {
  const since = run.lastVerdictAt ?? run.startedAt;
  const idleMinutes = Math.max(
    0,
    Math.round((Date.parse(now) - Date.parse(since)) / 60_000),
  );
  const limit = cadenceMinutes * ticks;
  if (run.verdicts >= run.targets && run.targets > 0) {
    return {
      stalled: false,
      idleMinutes,
      reason: "every target has a verdict",
    };
  }
  if (idleMinutes <= limit) {
    return {
      stalled: false,
      idleMinutes,
      reason: `progressing (idle ${idleMinutes}m of ${limit}m budget)`,
    };
  }
  return {
    stalled: true,
    idleMinutes,
    reason: `no verdict for ${idleMinutes}m (> ${ticks} auditor ticks of ` +
      `${cadenceMinutes}m) at ${run.verdicts}/${run.targets}`,
  };
}

/**
 * Who may dispatch an auditor for a run. While the auditor cron is enabled
 * it owns verdict authorship; the workflow observing the same run must not
 * dispatch a second worker onto it (knowfleet #453). The workflow takes over
 * only when the cron is not the owner, or on an explicit stall rescue.
 */
export function dispatchAllowed(input: {
  cronOwned: boolean;
  stalled: boolean;
  dispatch: boolean;
  role?: string;
}): { allowed: boolean; reason: string } {
  const role = input.role ?? "verdict authorship";
  if (!input.dispatch) {
    return { allowed: false, reason: "dispatch disabled for this pass" };
  }
  if (!input.cronOwned) {
    return { allowed: true, reason: "no cron owner — workflow drives" };
  }
  if (input.stalled) {
    return {
      allowed: true,
      reason: "stall rescue: cron owns the run but it has not progressed",
    };
  }
  return {
    allowed: false,
    reason: `the cron owns ${role} here — not dispatching a second worker ` +
      "(no-double-run, knowfleet #453)",
  };
}

/** A pass against any ledger but the real one is a test run (#400/#412). */
export function isInjected(dbPath: string): boolean {
  return dbPath !== DEFAULT_DB;
}

/** The normalised pass record the model persists. */
export interface AuditPass {
  ok: boolean;
  crashed: boolean;
  error: string | null;
  action: PassAction;
  reason: string;
  dbPath: string;
  injected: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  runId: string | null;
  triggerRef: string | null;
  targets: number;
  verdicts: Record<Verdict, number> & { total: number };
  completed: boolean;
  investigationsOpened: number[];
  dispatch: { attempted: boolean; allowed: boolean; reason: string };
  stall: { stalled: boolean; idleMinutes: number; reason: string } | null;
  batchesToday: number;
  needsHuman: string[];
}

/**
 * Where (if anywhere) this pass may write its heartbeat. A dry run never
 * vouches for the scheduled job, and an injected ledger never writes into
 * the production heartbeat dir.
 */
export function heartbeatTarget(
  pass: Pick<AuditPass, "injected" | "dryRun">,
  path: string,
): { path: string | null; reason: string } {
  if (path.trim() === "") return { path: null, reason: "heartbeat disabled" };
  if (pass.dryRun) {
    return { path: null, reason: "dry run — heartbeat not written" };
  }
  if (pass.injected && path.startsWith(PROD_HEARTBEAT_DIR)) {
    return {
      path: null,
      reason:
        "injected ledger — refusing the production heartbeat (knowfleet #412)",
    };
  }
  return { path, reason: "written" };
}

/** Refuse the production alert topic for injected passes (knowfleet #400). */
export function alertAllowed(
  pass: Pick<AuditPass, "injected">,
  url: string,
): { allowed: boolean; reason: string } {
  if (url.trim() === "") return { allowed: false, reason: "alerting disabled" };
  if (pass.injected && url.replace(/\/+$/, "") === PROD_ALERT_URL) {
    return {
      allowed: false,
      reason:
        "injected ledger — refusing the production alerts topic (knowfleet #400)",
    };
  }
  return { allowed: true, reason: "ok" };
}

/** ntfy title + body for a failed or stalled pass. Phone-banner short. */
export function alertMessage(pass: AuditPass): { title: string; body: string } {
  const run = pass.runId ? pass.runId.slice(0, 8) : "no run";
  if (pass.crashed) {
    return {
      title: "Audit ledger pass did not run",
      body: `${pass.error ?? "no evidence"}\n` +
        "Check: swamp data get audit-ledger lastPass --json",
    };
  }
  if (pass.stall?.stalled) {
    return {
      title: `Audit run ${run} is stalled`,
      body: `${pass.stall.reason}\n` +
        `${pass.verdicts.total}/${pass.targets} verdicts; ` +
        `${pass.dispatch.reason}\n` +
        "Re-run: swamp workflow run audit-ledger",
    };
  }
  const lines = [
    `action: ${pass.action} — ${pass.reason}`,
    `verdicts: ${pass.verdicts.total}/${pass.targets} ` +
    `(retain ${pass.verdicts.retain}, mr ${
      pass.verdicts["machine-revisable"]
    }, ` +
    `needs-human ${
      pass.verdicts["needs-human"]
    }, reject ${pass.verdicts.reject})`,
  ];
  if (pass.needsHuman.length) {
    lines.push(`needs-human: ${pass.needsHuman.join(" ")} — guru decision`);
  }
  if (pass.error) lines.push(pass.error);
  return {
    title: `Audit ledger pass FAILED (${run})`,
    body: lines.join("\n") + "\nRe-run: swamp workflow run audit-ledger",
  };
}

/** Last n non-empty lines of a text blob. */
export function lastLines(text: string, n: number): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join(
    " | ",
  );
}

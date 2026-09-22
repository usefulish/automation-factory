/**
 * Pure helpers for the A2A conformance model: suite argument construction,
 * report normalisation, alert text, and the production-surface guards.
 *
 * Everything here is side-effect free so it can be unit-tested without the
 * suite, the edges, the Keychain, or ntfy (see ../a2a_conformance_test.ts).
 *
 * @module
 */

/** The suite this model exists to run. Anything else is an injected stub. */
export const DEFAULT_SUITE =
  "/Users/guru/Code/active/a2a-edge/scripts/conformance.mjs";

/** Production escalation topic (tools.md "Notifications": error -> alerts). */
export const PROD_ALERT_URL = "https://ntfy.oryx-herring.ts.net/alerts";

/**
 * Directory the layer-1 heartbeat checker watches (knowfleet task #146,
 * design 4aa5a381). A heartbeat written here tells that checker the job is
 * alive, so a test run must never write one (knowfleet #412).
 */
export const PROD_HEARTBEAT_DIR =
  "/Users/guru/Scripts/network-status/machines/kimchi/heartbeats/";

export const DEFAULT_HEARTBEAT = PROD_HEARTBEAT_DIR +
  "a2a-conformance.heartbeat";

/** Every run overwrites this instance; its versions are the history. */
export const RUN_INSTANCE = "lastRun";

/** One probe result as conformance.mjs writes it. */
export interface ProbeResult {
  probe: string;
  status: "pass" | "fail" | "inconclusive";
  detail: string;
}

/** One target as conformance.mjs writes it. */
export interface TargetResult {
  name: string;
  url: string;
  kind: "edge" | "reference";
  ms: number;
  passed: number;
  failed: number;
  inconclusive: number;
  results: ProbeResult[];
}

/** The normalised run record the model persists as its `run` resource. */
export interface ConformanceRun {
  ok: boolean;
  crashed: boolean;
  error: string | null;
  gate: string;
  strict: boolean;
  only: string[];
  skipSlow: boolean;
  exitCode: number;
  timedOut: boolean;
  suitePath: string;
  injected: boolean;
  startedAt: string;
  finishedAt: string;
  cliCommit: string | null;
  totals: {
    targets: number;
    failedTargets: number;
    probes: number;
    failedProbes: number;
    inconclusive: number;
  };
  targets: TargetResult[];
}

/** Split a comma/space separated target filter into distinct prefixes. */
export function parseOnly(only: string | undefined): string[] {
  return [
    ...new Set(
      (only ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    ),
  ];
}

/** Build the conformance.mjs argv (without the node binary and script). */
export function buildSuiteArgs(opts: {
  only: string[];
  strict: boolean;
  skipSlow: boolean;
  jsonPath: string;
}): string[] {
  const args = ["--json", opts.jsonPath];
  for (const o of opts.only) args.push("--only", o);
  if (opts.strict) args.push("--strict");
  if (opts.skipSlow) args.push("--skip-slow");
  return args;
}

/**
 * Normalise the suite's JSON report (or its absence) into a run record.
 *
 * The suite decides `ok` itself (edges-only unless --strict); that verdict is
 * kept, but a missing report or a non-zero exit with no report is a crash,
 * and a zero exit that contradicts the report is treated as a failure — the
 * gate never reads green on evidence that is not there.
 */
export function summarize(input: {
  report: Record<string, unknown> | null;
  exitCode: number;
  timedOut: boolean;
  stderr: string;
  strict: boolean;
  only: string[];
  skipSlow: boolean;
  suitePath: string;
  startedAt: string;
  finishedAt: string;
}): ConformanceRun {
  const r = input.report;
  const targets = Array.isArray(r?.targets)
    ? (r!.targets as TargetResult[])
    : [];
  const crashed = r === null || input.timedOut;
  const probes = targets.reduce((n, t) => n + (t.results?.length ?? 0), 0);
  const failedProbes = targets.reduce((n, t) => n + (t.failed ?? 0), 0);
  const inconclusive = targets.reduce((n, t) => n + (t.inconclusive ?? 0), 0);
  const reportOk = r !== null && r.ok === true;
  const ok = !crashed && reportOk && input.exitCode === 0 &&
    targets.length > 0;

  let error: string | null = null;
  if (input.timedOut) error = "suite timed out";
  else if (r === null) {
    error = `suite produced no report (exit ${input.exitCode}): ${
      lastLines(input.stderr, 3) || "no stderr"
    }`;
  } else if (targets.length === 0) error = "suite ran no targets";
  else if (reportOk !== (input.exitCode === 0)) {
    error = `suite exit ${input.exitCode} disagrees with report ok=${reportOk}`;
  }

  return {
    ok,
    crashed,
    error,
    gate: typeof r?.gate === "string"
      ? r.gate as string
      : (input.strict ? "all targets" : "edges only"),
    strict: input.strict,
    only: input.only,
    skipSlow: input.skipSlow,
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    suitePath: input.suitePath,
    injected: isInjected(input.suitePath),
    startedAt: typeof r?.startedAt === "string"
      ? r.startedAt as string
      : input.startedAt,
    finishedAt: typeof r?.finishedAt === "string"
      ? r.finishedAt as string
      : input.finishedAt,
    cliCommit: typeof r?.cliCommit === "string" ? r.cliCommit as string : null,
    totals: {
      targets: targets.length,
      failedTargets: targets.filter((t) => t.failed > 0).length,
      probes,
      failedProbes,
      inconclusive,
    },
    targets,
  };
}

/** A run whose suite is not the real one is a test run (knowfleet #400/#412). */
export function isInjected(suitePath: string): boolean {
  return suitePath !== DEFAULT_SUITE;
}

/**
 * Where (if anywhere) this run may write its heartbeat. Subset runs never
 * do — a `--only codex` spot check must not vouch for the full scheduled
 * job — and injected runs never write into the production heartbeat dir.
 */
export function heartbeatTarget(
  run: Pick<ConformanceRun, "only" | "injected">,
  path: string,
): { path: string | null; reason: string } {
  if (path.trim() === "") return { path: null, reason: "heartbeat disabled" };
  if (run.only.length > 0) {
    return { path: null, reason: "subset run (only) — heartbeat not written" };
  }
  if (run.injected && path.startsWith(PROD_HEARTBEAT_DIR)) {
    return {
      path: null,
      reason:
        "injected suite — refusing to write the production heartbeat (knowfleet #412)",
    };
  }
  return { path, reason: "written" };
}

/** Refuse the production alert topic for injected runs (knowfleet #400). */
export function alertAllowed(
  run: Pick<ConformanceRun, "injected">,
  url: string,
): { allowed: boolean; reason: string } {
  if (url.trim() === "") return { allowed: false, reason: "alerting disabled" };
  if (run.injected && url.replace(/\/+$/, "") === PROD_ALERT_URL) {
    return {
      allowed: false,
      reason:
        "injected suite — refusing the production alerts topic (knowfleet #400)",
    };
  }
  return { allowed: true, reason: "ok" };
}

/** ntfy title + body for a failed run. Short enough for a phone banner. */
export function alertMessage(run: ConformanceRun): {
  title: string;
  body: string;
} {
  const scope = run.only.length ? ` [${run.only.join(",")}]` : "";
  if (run.crashed || run.targets.length === 0) {
    return {
      title: `A2A conformance did not run${scope}`,
      body: `${run.error ?? "no report"}\n` +
        "Check: swamp data get a2a-conformance lastRun --json",
    };
  }
  const lines: string[] = [];
  for (const t of run.targets.filter((t) => t.failed > 0)) {
    const first = t.results.find((p) => p.status === "fail");
    lines.push(
      `${t.name} (${t.kind}) ${t.passed}/${t.results.length}` +
        (first ? ` — ${first.probe}: ${first.detail.slice(0, 120)}` : ""),
    );
  }
  if (run.error) lines.push(run.error);
  return {
    title: `A2A conformance FAILED (${run.gate})${scope}`,
    body: lines.join("\n") + "\nRe-run: swamp workflow run a2a-conformance",
  };
}

/** Last n non-empty lines of a text blob. */
export function lastLines(text: string, n: number): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join(
    " | ",
  );
}

/**
 * Read-only ledger queries for the audit-ledger model.
 *
 * Reads go through the `sqlite3` CLI against a `file:…?mode=ro` URI — the
 * same read-only, WAL-safe access the knowfleet poll probes use
 * (audit-run-probe.py, candidate-audit-probe.py, ledger-mr-probe.py). The
 * model never writes SQLite: every mutation goes through the knowfleet MCP
 * surface (see mcp.ts), because the ledger's invariants — version-hash
 * snapshotting, the machine-revisable precondition on investigations, the
 * completed-run verdict refusal — live in that server, not in the schema.
 *
 * @module
 */

import type { LedgerSnapshot, RunRow, VerdictRow } from "./ledger.ts";

/** Watermark the daily candidate audit advances (cron 6baadbef2952). */
export const DEFAULT_WATERMARK =
  "/Users/guru/.hermes/profiles/librarian/scripts/.candidate-audit-watermark";

const SQLITE = "/usr/bin/sqlite3";

/** Wait this long for a busy lock before giving up (ms). */
const BUSY_TIMEOUT_MS = 10_000;

async function sqlite(
  args: string[],
  sql: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(SQLITE, {
    // The ledger has a live writer (knowfleet-http, the agent profiles, the
    // MCP session this very pass opens). Without a busy timeout a reader
    // that lands mid-commit fails outright with SQLITE_BUSY.
    args: ["-cmd", `.timeout ${BUSY_TIMEOUT_MS}`, ...args, sql],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

/**
 * Run one query and parse `sqlite3 -json` output.
 *
 * Read-only first. The fallback matters: the knowfleet ledger is in WAL
 * mode, and opening a WAL database read-only requires its `-shm` sidecar to
 * already exist — SQLite cannot create one without write access. In
 * production that file is always present because knowfleet-http holds the
 * database open, but a freshly restored copy, a test ledger, or production
 * with every knowfleet process stopped has no `-shm`, and a strictly
 * read-only open fails with SQLITE_CANTOPEN (14).
 *
 * So on exactly that failure we retry with a normal open, which lets SQLite
 * build the shared-memory index. Only SELECTs are ever issued either way —
 * the ledger's rows are never written from here (the audit-loop contract
 * forbids direct SQLite mutation; creating a WAL index is not a row write).
 */
export async function queryJson<T>(
  dbPath: string,
  sql: string,
  signal?: AbortSignal,
): Promise<T[]> {
  let res = await sqlite(
    ["-json", "-readonly", `file:${dbPath}?mode=ro`],
    sql,
    signal,
  );
  if (res.code !== 0 && /unable to open database file/i.test(res.stderr)) {
    res = await sqlite(["-json", dbPath], sql, signal);
  }
  if (res.code !== 0) {
    throw new Error(
      `ledger query failed (exit ${res.code}): ${res.stderr.trim()}`,
    );
  }
  const text = res.stdout.trim();
  // sqlite3 -json prints nothing at all for an empty result set.
  if (text === "") return [];
  return JSON.parse(text) as T[];
}

interface RawRun {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  trigger_ref: string | null;
  auditor_profile: string | null;
  loop: number;
  targets: number;
  verdicts: number;
  last_verdict_at: string | null;
}

const RUN_SELECT = `
  SELECT r.id, r.status, r.started_at, r.completed_at,
         r.trigger_ref, r.auditor_profile, r.loop,
         (SELECT COUNT(*) FROM audit_targets t WHERE t.run_id = r.id)
           AS targets,
         (SELECT COUNT(*) FROM audit_verdicts v WHERE v.run_id = r.id)
           AS verdicts,
         (SELECT MAX(v.created_at) FROM audit_verdicts v WHERE v.run_id = r.id)
           AS last_verdict_at
  FROM audit_runs r`;

function toRun(r: RawRun): RunRow {
  return {
    id: r.id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status as RunRow["status"],
    triggerRef: r.trigger_ref ?? "",
    auditorProfile: r.auditor_profile,
    loop: r.loop,
    targets: r.targets,
    verdicts: r.verdicts,
    lastVerdictAt: r.last_verdict_at,
  };
}

/** Every run still `running`, oldest first (lesson 14583002: ANY run). */
export async function runningRuns(
  db: string,
  signal?: AbortSignal,
): Promise<RunRow[]> {
  const rows = await queryJson<RawRun>(
    db,
    `${RUN_SELECT} WHERE r.status = 'running' ORDER BY r.started_at`,
    signal,
  );
  return rows.map(toRun);
}

/** Recent runs, newest first — the pacing and "already opened" evidence. */
export async function recentRuns(
  db: string,
  limit: number,
  signal?: AbortSignal,
): Promise<RunRow[]> {
  const rows = await queryJson<RawRun>(
    db,
    `${RUN_SELECT} ORDER BY r.started_at DESC LIMIT ${Number(limit) | 0}`,
    signal,
  );
  return rows.map(toRun);
}

/** One run by id (full uuid or 8-char prefix), or null. */
export async function readRun(
  db: string,
  id: string,
  signal?: AbortSignal,
): Promise<RunRow | null> {
  const safe = id.replace(/'/g, "''");
  const rows = await queryJson<RawRun>(
    db,
    `${RUN_SELECT} WHERE r.id = '${safe}' OR r.id LIKE '${safe}%' LIMIT 1`,
    signal,
  );
  return rows.length ? toRun(rows[0]) : null;
}

/**
 * Candidates the DAILY run would audit: recorded since the watermark. This
 * mirrors candidate-audit-probe.py exactly, including the UTC boundary.
 */
export async function dailyCandidates(
  db: string,
  watermark: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const safe = watermark.replace(/'/g, "''");
  const rows = await queryJson<{ id: string }>(
    db,
    `SELECT id FROM knowledge
     WHERE status = 'candidate' AND created_at > '${safe}T00:00:00.000Z'
     ORDER BY created_at ASC`,
    signal,
  );
  return rows.map((r) => r.id);
}

/** Candidates carrying no verdict at all — the #450 reconciliation gap. */
export async function verdictlessCandidates(
  db: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const rows = await queryJson<{ id: string }>(
    db,
    `SELECT k.id FROM knowledge k
     WHERE k.status = 'candidate'
       AND NOT EXISTS (
         SELECT 1 FROM audit_verdicts v WHERE v.record_id = k.id
       )
     ORDER BY k.updated_at ASC`,
    signal,
  );
  return rows.map((r) => r.id);
}

interface RawVerdict {
  id: number;
  run_id: string;
  target_id: number;
  record_id: string | null;
  verdict: string;
  finding: string | null;
  created_at: string;
  investigations: number;
}

function toVerdict(v: RawVerdict): VerdictRow {
  return {
    id: v.id,
    runId: v.run_id,
    targetId: v.target_id,
    recordId: v.record_id,
    verdict: v.verdict as VerdictRow["verdict"],
    finding: v.finding,
    createdAt: v.created_at,
    hasInvestigation: v.investigations > 0,
  };
}

const VERDICT_SELECT = `
  SELECT v.id, v.run_id, v.target_id, v.record_id, v.verdict, v.finding,
         v.created_at,
         (SELECT COUNT(*) FROM investigations i
           WHERE i.originating_verdict_id = v.id) AS investigations
  FROM audit_verdicts v`;

/** Verdicts recorded against one run, oldest first. */
export async function runVerdicts(
  db: string,
  runId: string,
  signal?: AbortSignal,
): Promise<VerdictRow[]> {
  const safe = runId.replace(/'/g, "''");
  const rows = await queryJson<RawVerdict>(
    db,
    `${VERDICT_SELECT} WHERE v.run_id = '${safe}' ORDER BY v.created_at, v.id`,
    signal,
  );
  return rows.map(toVerdict);
}

/**
 * Machine-revisable verdicts from COMPLETED runs that have no investigation.
 *
 * ledger-mr-probe.py restricts this to daily runs so the #372 backfill is
 * never re-investigated. That restriction would also exclude every #450
 * reconciliation batch — the very runs this workflow exists to drive — so
 * the backfill is excluded by name instead, which is what the daily-only
 * clause was actually reaching for (the same shape of mistake as lesson
 * 14583002).
 */
export async function dispatchableMr(
  db: string,
  signal?: AbortSignal,
): Promise<VerdictRow[]> {
  const rows = await queryJson<RawVerdict>(
    db,
    `${VERDICT_SELECT}
     JOIN audit_runs r ON r.id = v.run_id
     WHERE v.verdict = 'machine-revisable'
       AND r.status = 'completed'
       AND COALESCE(r.trigger_ref, '') NOT LIKE '#372 backfill%'
       AND NOT EXISTS (
         SELECT 1 FROM investigations i
         WHERE i.originating_verdict_id = v.id
       )
     ORDER BY r.started_at, v.id`,
    signal,
  );
  return rows.map(toVerdict);
}

/** Investigations still running. */
export async function openInvestigations(
  db: string,
  signal?: AbortSignal,
): Promise<number> {
  const rows = await queryJson<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM investigations WHERE status = 'running'",
    signal,
  );
  return rows[0]?.n ?? 0;
}

/** Read the daily watermark, defaulting to the epoch like the probe does. */
export async function readWatermark(path: string): Promise<string> {
  try {
    return (await Deno.readTextFile(path)).trim() || "1970-01-01";
  } catch {
    return "1970-01-01";
  }
}

/** Everything one pass needs to decide, in a single read. */
export async function readSnapshot(input: {
  db: string;
  watermarkPath: string;
  recentLimit: number;
  signal?: AbortSignal;
}): Promise<LedgerSnapshot> {
  const { db, watermarkPath, recentLimit, signal } = input;
  const watermark = await readWatermark(watermarkPath);
  // Sequential on purpose. Each query is a separate sqlite3 process, and
  // firing them concurrently makes them race to create the WAL `-shm`
  // index — which shows up as an intermittent SQLITE_BUSY and a pass that
  // fails for no reason the ledger can explain. These reads are
  // millisecond-cheap; the parallelism bought nothing and cost determinism.
  const running = await runningRuns(db, signal);
  const recent = await recentRuns(db, recentLimit, signal);
  const daily = await dailyCandidates(db, watermark, signal);
  const verdictless = await verdictlessCandidates(db, signal);
  const mr = await dispatchableMr(db, signal);
  const open = await openInvestigations(db, signal);
  return {
    at: new Date().toISOString(),
    runningRuns: running,
    recentRuns: recent,
    dailyCandidates: daily,
    verdictlessCandidates: verdictless,
    openInvestigations: open,
    dispatchableMr: mr,
  };
}

/** One open investigation, oldest first (the investigator probe's FIFO). */
export interface OpenInvestigation {
  id: number;
  verdictId: number;
  recordId: string | null;
  startedAt: string;
}

/**
 * Investigations still running, oldest first. Mirrors
 * investigation-probe.py, including its generalisation to ANY running
 * investigation rather than only those from daily runs (lesson 14583002).
 */
export async function runningInvestigations(
  db: string,
  signal?: AbortSignal,
): Promise<OpenInvestigation[]> {
  const rows = await queryJson<{
    id: number;
    verdict_id: number;
    record_id: string | null;
    started_at: string;
  }>(
    db,
    `SELECT i.id, i.originating_verdict_id AS verdict_id, v.record_id,
            i.started_at
     FROM investigations i
     JOIN audit_verdicts v ON v.id = i.originating_verdict_id
     WHERE i.status = 'running'
     ORDER BY i.started_at, i.id`,
    signal,
  );
  return rows.map((r) => ({
    id: r.id,
    verdictId: r.verdict_id,
    recordId: r.record_id,
    startedAt: r.started_at,
  }));
}

/**
 * Ownership probe for the knowfleet audit cron polls.
 *
 * The auditor poll (hermes job 883029b254e4, every 30m) and the investigator
 * poll (63133383b02c) already author verdicts and remediate. While either is
 * enabled it OWNS that half of the loop, and this workflow must not dispatch
 * a second worker onto the same run — that is the no-double-run constraint
 * in knowfleet task #453.
 *
 * Ownership is read from the profile's own jobs.json, which is where hermes
 * keeps both the definition and the live scheduler state. A job that is
 * missing, disabled, or paused is NOT an owner, which is how you hand the
 * loop to this workflow: pause the cron and the workflow takes over.
 *
 * @module
 */

export interface CronOwner {
  /** The job exists, is enabled, and is not paused. */
  owned: boolean;
  reason: string;
  jobId: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface RawJob {
  id: string;
  enabled?: boolean;
  state?: string;
  paused_at?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
}

/** hermes profile jobs file, e.g. profile "auditor". */
export function jobsPath(profile: string): string {
  return `/Users/guru/.hermes/profiles/${profile}/cron/jobs.json`;
}

/**
 * Decide ownership from an already-parsed jobs file. Pure, so the
 * hand-off semantics are unit-testable without hermes on disk.
 */
export function ownerFrom(
  jobs: RawJob[],
  jobId: string,
  role = "verdict authorship",
): CronOwner {
  const job = jobs.find((j) => j.id === jobId);
  const base = { jobId, lastRunAt: null, nextRunAt: null };
  if (!job) {
    return {
      ...base,
      owned: false,
      reason: `cron ${jobId} not found — workflow owns the loop`,
    };
  }
  const info = {
    jobId,
    lastRunAt: job.last_run_at ?? null,
    nextRunAt: job.next_run_at ?? null,
  };
  if (job.enabled === false) {
    return { ...info, owned: false, reason: `cron ${jobId} is disabled` };
  }
  if (job.state === "paused" || job.paused_at) {
    return { ...info, owned: false, reason: `cron ${jobId} is paused` };
  }
  return {
    ...info,
    owned: true,
    reason: `cron ${jobId} is active (next ${job.next_run_at ?? "unknown"}) ` +
      `— it owns ${role}`,
  };
}

/** Read a hermes profile's jobs file and decide ownership. */
export async function cronOwner(
  path: string,
  jobId: string,
  role = "verdict authorship",
): Promise<CronOwner> {
  let parsed: { jobs?: RawJob[] };
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    // An unreadable jobs file must not be read as "nobody owns this" —
    // that would licence a duplicate dispatch. Treat it as owned.
    return {
      owned: true,
      jobId,
      lastRunAt: null,
      nextRunAt: null,
      reason: `cannot read ${path} (${
        e instanceof Error ? e.message : e
      }) — assuming the cron owns the loop`,
    };
  }
  return ownerFrom(parsed.jobs ?? [], jobId, role);
}

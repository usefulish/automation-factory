/**
 * Auditor / investigator dispatch for the audit-ledger model.
 *
 * The workflow ORCHESTRATES; it never stamps a verdict. That boundary is
 * the audit-loop contract (knowfleet-audit-loop.md): the Auditor classifies
 * and is read-only on knowledge, the Investigator remediates through the
 * governed surface, and the coordinator does neither. So the only way this
 * model gets a verdict authored is by dispatching the auditor profile — the
 * same profile, soul, and knowfleet provenance the cron poll uses — and
 * waiting for it to write through its OWN knowfleet session.
 *
 * The prompts below are derived from the live cron prompts (883029b254e4
 * and 63133383b02c) so a dispatched pass and a cron tick ask for exactly
 * the same work.
 *
 * @module
 */

/** Prompt the auditor profile receives for one run. Pure, so it is testable. */
export function auditorPrompt(runId: string): string {
  return [
    `Work audit run ${runId} on the knowfleet ledger to completion.`,
    "",
    "1. Run your required pre-work searches (context_begin) before working.",
    `2. audit_run_read ${runId}: list targets (target_id, record_id) and any`,
    "   verdicts already recorded.",
    "3. For each target WITHOUT a verdict: knowledge_read the current record",
    "   head in full; classify it as EXACTLY one of",
    "   retain | machine-revisable | needs-human | reject per the audit-loop",
    "   contract (knowfleet-audit-loop.md: adversarial, primary evidence,",
    "   read-only on knowledge); audit_verdict_add(run_id, target_id, verdict,",
    "   finding=<one-line evidence-bounded reason>,",
    "   evidence_ref=<what you inspected>).",
    "4. Do NOT complete the run — the orchestrating workflow completes it once",
    "   every target has a verdict.",
    "5. You recommend only: never modify knowledge records, never supersede,",
    "   never create tasks or kanban cards, never write SQLite directly.",
    "",
    "Resume means skipping targets that already have verdicts.",
  ].join("\n");
}

/** Prompt the investigator profile receives for one investigation. */
export function investigatorPrompt(
  investigationId: number,
  recordId: string,
): string {
  return [
    `Work investigation ${investigationId} (record ${recordId}) on the`,
    "knowfleet ledger to completion.",
    "",
    "1. Run your required pre-work searches (context_begin) before working.",
    "2. Read the originating verdict's run for the target record_id, the",
    "   Auditor finding, evidence_ref, and version hash.",
    "3. Treat the Auditor finding as a lead, not truth: independently verify,",
    "   narrow, or falsify against primary evidence. Push back where the",
    "   Auditor overclaims.",
    "4. If confirmed or narrowed: remediate through the governed surface ONLY",
    "   (knowledge_supersede / knowledge_update) — never direct SQLite.",
    "   Preserve the supportable core; provenance is your own.",
    `5. investigation_complete(${investigationId}, outcome=confirmed|narrowed|`,
    "   falsified|needs-human, replacement_id=<new record id if created>,",
    "   evidence_ref=...).",
    "6. Never self-approve: a replacement is a fresh candidate that goes",
    "   through a fresh audit run.",
  ].join("\n");
}

export interface DispatchResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run one headless hermes turn as `profile`. Never throws on a non-zero
 * exit — a failed dispatch is data the pass records, not a crash.
 */
export async function dispatchAgent(input: {
  hermesPath: string;
  profile: string;
  prompt: string;
  workdir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const out = await new Deno.Command(input.hermesPath, {
      args: ["-p", input.profile, "-z", input.prompt],
      cwd: input.workdir,
      env: {
        PATH: `/opt/homebrew/bin:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        HOME: Deno.env.get("HOME") ?? "/Users/guru",
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    const dec = new TextDecoder();
    return {
      ok: out.code === 0 && !timedOut,
      exitCode: out.code,
      timedOut,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
    };
  } catch (e) {
    return {
      ok: false,
      exitCode: timedOut ? 124 : 127,
      timedOut,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

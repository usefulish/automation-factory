/**
 * Post-execution report for the knowfleet audit ledger: renders the
 * persisted `pass` resource as the plan, the guards that fired, the verdict
 * tally, and the investigations opened. Runs even when the pass threw, so a
 * failing pass shows what it decided and where it stopped.
 *
 * @module
 */

import { type AuditPass, PASS_INSTANCE } from "./_lib/ledger.ts";

interface ReportContext {
  readonly modelType: string;
  readonly modelId: string;
  readonly methodName: string;
  readonly executionStatus: string;
  readonly errorMessage?: string;
  readonly definition: { readonly name: string };
  readonly dataHandles: ReadonlyArray<
    {
      readonly name: string;
      readonly specName?: string;
      readonly version?: number;
    }
  >;
  readonly dataRepository: {
    getContent(
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

/** Render a pass record as markdown. Exported for tests. */
export function renderPass(pass: AuditPass): string {
  const run = pass.runId ? pass.runId.slice(0, 8) : "none";
  const out = [
    `## ${pass.ok ? "OK" : "FAILED"} — ${pass.action}${
      pass.dryRun ? " (dry run)" : ""
    }`,
    "",
    `- **Reason**: ${pass.reason}`,
    `- **Window**: ${pass.startedAt} → ${pass.finishedAt}`,
    `- **Run**: ${run}${pass.triggerRef ? ` — ${pass.triggerRef}` : ""}`,
    `- **Verdicts**: ${pass.verdicts.total}/${pass.targets} ` +
    `(retain ${pass.verdicts.retain}, machine-revisable ` +
    `${pass.verdicts["machine-revisable"]}, needs-human ` +
    `${pass.verdicts["needs-human"]}, reject ${pass.verdicts.reject})`,
    `- **Completed this pass**: ${pass.completed ? "yes" : "no"}`,
    `- **Batches opened today**: ${pass.batchesToday}`,
  ];
  if (pass.injected) out.push(`- **Injected ledger**: \`${pass.dbPath}\``);
  out.push(
    `- **Dispatch**: ${
      pass.dispatch.attempted ? "attempted" : "not attempted"
    } — ${pass.dispatch.reason}`,
  );
  if (pass.stall) out.push(`- **Progress**: ${pass.stall.reason}`);
  if (pass.investigationsOpened.length) {
    out.push(
      `- **Investigations opened**: ${
        pass.investigationsOpened.map((i) => `#${i}`).join(", ")
      }`,
    );
  }
  if (pass.needsHuman.length) {
    out.push(
      `- **Needs human**: ${pass.needsHuman.join(", ")} — guru decision needed`,
    );
  }
  if (pass.error) out.push(`- **Error**: ${pass.error}`);
  return out.join("\n") + "\n";
}

export const report = {
  name: "@usefulish/audit-ledger-summary",
  description:
    "Summarise one knowfleet audit pass — plan, guards, verdict tally, completion, and investigations opened",
  scope: "method",
  labels: ["knowfleet", "audit", "ledger"],

  execute: async (
    ctx: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const head = [
      `# Audit ledger — \`${ctx.methodName}\``,
      "",
      `- **Model**: ${ctx.definition.name}`,
      `- **Status**: ${ctx.executionStatus}`,
      "",
    ];
    const json: Record<string, unknown> = {
      model: ctx.definition.name,
      method: ctx.methodName,
      status: ctx.executionStatus,
    };
    if (ctx.methodName !== "pass") {
      if (ctx.errorMessage) head.push("```", ctx.errorMessage, "```");
      return { markdown: head.join("\n"), json };
    }
    // A failed pass throws after persisting, so the method returns no data
    // handles; fall back to the newest version of the pass instance.
    const handle = ctx.dataHandles.find((h) => h.specName === "pass");
    const raw = await ctx.dataRepository.getContent(
      ctx.modelType,
      ctx.modelId,
      handle?.name ?? PASS_INSTANCE,
      handle?.version,
    );
    if (raw === null) {
      if (ctx.errorMessage) head.push("```", ctx.errorMessage, "```");
      return { markdown: head.join("\n"), json };
    }
    const pass = JSON.parse(new TextDecoder().decode(raw)) as AuditPass;
    json.pass = {
      ok: pass.ok,
      action: pass.action,
      runId: pass.runId,
      verdicts: pass.verdicts,
      completed: pass.completed,
      investigationsOpened: pass.investigationsOpened,
      needsHuman: pass.needsHuman,
      error: pass.error,
    };
    return { markdown: head.join("\n") + renderPass(pass), json };
  },
};

/**
 * Post-execution report for the A2A conformance gate: renders the persisted
 * `run` resource as a per-target table plus every non-pass probe. Runs even
 * when the gate threw, so a failing run shows what failed.
 *
 * @module
 */

import { type ConformanceRun, RUN_INSTANCE } from "./_lib/summary.ts";

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

/** Render a run record as markdown. Exported for tests. */
export function renderRun(run: ConformanceRun): string {
  const out = [
    `## ${run.ok ? "PASS" : "FAIL"} — gate: ${run.gate}${
      run.only.length ? ` (only ${run.only.join(", ")})` : ""
    }`,
    "",
    `- **Window**: ${run.startedAt} → ${run.finishedAt}`,
    `- **Oracle**: a2a-cli ${run.cliCommit ?? "unknown"}`,
    `- **Totals**: ${run.totals.targets} target(s), ${run.totals.probes} probe(s), ` +
    `${run.totals.failedProbes} failed, ${run.totals.inconclusive} inconclusive`,
  ];
  if (run.injected) out.push(`- **Injected suite**: \`${run.suitePath}\``);
  if (run.error) out.push(`- **Error**: ${run.error}`);
  if (run.targets.length) {
    out.push(
      "",
      "| Target | Kind | Pass | Fail | Inconclusive | Time |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const t of run.targets) {
      out.push(
        `| ${t.name} | ${t.kind} | ${t.passed}/${t.results.length} | ${t.failed} | ${t.inconclusive} | ${
          Math.round(t.ms / 1000)
        }s |`,
      );
    }
    const odd = run.targets.flatMap((t) =>
      t.results.filter((p) => p.status !== "pass").map((p) =>
        `- \`${t.name}\` **${p.status}** ${p.probe}: ${p.detail}`
      )
    );
    if (odd.length) out.push("", "### Non-pass probes", "", ...odd);
  }
  return out.join("\n");
}

export const report = {
  name: "@usefulish/a2a-conformance-summary",
  description:
    "Summarise an A2A conformance run — gate verdict, per-target counts, and every failed or inconclusive probe",
  scope: "method",
  labels: ["a2a", "conformance", "audit"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const head = [
      `# A2A conformance — \`${context.methodName}\``,
      "",
      `- **Model**: ${context.definition.name}`,
      `- **Status**: ${context.executionStatus}`,
      "",
    ];
    const json: Record<string, unknown> = {
      model: context.definition.name,
      method: context.methodName,
      status: context.executionStatus,
    };
    if (context.methodName !== "run") {
      if (context.errorMessage) head.push("```", context.errorMessage, "```");
      return { markdown: head.join("\n"), json };
    }
    // A failed gate throws after persisting, so the method returns no data
    // handles; fall back to the newest version of the run instance.
    const handle = context.dataHandles.find((h) => h.specName === "run");
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      handle?.name ?? RUN_INSTANCE,
      handle?.version,
    );
    if (raw === null) {
      if (context.errorMessage) head.push("```", context.errorMessage, "```");
      return { markdown: head.join("\n"), json };
    }
    const run = JSON.parse(new TextDecoder().decode(raw)) as ConformanceRun;
    json.run = {
      ok: run.ok,
      gate: run.gate,
      totals: run.totals,
      error: run.error,
    };
    return { markdown: head.join("\n") + renderRun(run), json };
  },
};

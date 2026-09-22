/**
 * Regression tests for the audit-ledger workflow's evaluated form, via the
 * real `swamp workflow evaluate`. Pins what a scheduled (no-input) run
 * does: orchestrate without dispatching a second auditor, open runs within
 * the Sol pacing, and escalate through a job that runs whether the pass
 * passed or failed.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

interface Job {
  name: string;
  dependsOn?: Array<{ job: string; condition: { type: string } }>;
  steps: Array<{ name: string; task: { inputs?: Record<string, unknown> } }>;
}

async function evaluate(inputs: Record<string, string>): Promise<Job[]> {
  const args = ["workflow", "evaluate", "audit-ledger"];
  for (const [k, v] of Object.entries(inputs)) {
    const typed = v === "true" || v === "false" || /^\d+$/.test(v);
    args.push("--input", typed ? `${k}:json=${v}` : `${k}=${v}`);
  }
  const { stdout, stderr, success, code } = await new Deno.Command("swamp", {
    args,
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const combined = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);
  assert(success, `evaluate failed (${code}):\n${combined}`);
  const m = combined.match(/Output: "(.+)"/);
  assert(m, `no evaluated output path in:\n${combined}`);
  return (parseYaml(await Deno.readTextFile(m[1])) as { jobs: Job[] }).jobs;
}

// `swamp workflow evaluate` with NO inputs leaves expressions unevaluated,
// so the defaults are pinned by supplying one unrelated input. The truly
// input-less path (what launchd runs) is covered by the live run receipt.
Deno.test("defaults: orchestrate only, open allowed, production topic", async () => {
  const jobs = await evaluate({ maxInvestigations: "5" });
  const pass = jobs.find((j) => j.name === "audit")!.steps[0].task.inputs!;
  // The scheduled job must NOT dispatch a second auditor by default: the
  // auditor cron owns verdict authorship (knowfleet #453).
  assertEquals(pass.dispatch, false);
  assertEquals(pass.open, true);
  assertEquals(pass.allowDaily, true);
  assertEquals(pass.allowBatch, true);
  assertEquals(pass.investigate, true);
  assertEquals(pass.dryRun, false);
  assertEquals(pass.failOnError, true);
  assertEquals(
    jobs.find((j) => j.name === "escalate")!.steps[0].task.inputs!.url,
    "https://ntfy.oryx-herring.ts.net/alerts",
  );
});

// Escalation must run on a SUCCEEDED pass too: a green pass that produced
// needs-human verdicts still needs a human. `completed`, not `failed`.
Deno.test("escalate runs whether the pass passed or failed", async () => {
  const jobs = await evaluate({ maxInvestigations: "5" });
  assertEquals(jobs.find((j) => j.name === "escalate")!.dependsOn, [{
    job: "audit",
    condition: { type: "completed" },
  }]);
});

Deno.test("on-demand inputs pass through", async () => {
  const jobs = await evaluate({
    dispatch: "true",
    dryRun: "true",
    allowBatch: "false",
    maxInvestigations: "0",
    alertUrl: "",
  });
  const pass = jobs.find((j) => j.name === "audit")!.steps[0].task.inputs!;
  assertEquals(pass.dispatch, true);
  assertEquals(pass.dryRun, true);
  assertEquals(pass.allowBatch, false);
  assertEquals(pass.maxInvestigations, 0);
  assertEquals(
    jobs.find((j) => j.name === "escalate")!.steps[0].task.inputs!.url,
    "",
  );
});

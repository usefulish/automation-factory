/**
 * Regression tests for the a2a-conformance workflow's evaluated form, via the
 * real `swamp workflow evaluate`. Pins what a scheduled (no-input) run does:
 * strict gating, all targets, production alert topic — and that the escalate
 * job only runs when the audit fails.
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
  const args = ["workflow", "evaluate", "a2a-conformance"];
  for (const [k, v] of Object.entries(inputs)) {
    const typed = v === "true" || v === "false";
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

// `swamp workflow evaluate` with NO inputs leaves expressions unevaluated, so
// the defaults are pinned by supplying one unrelated input. The truly
// input-less path (what launchd runs) is covered by the live run receipt.
Deno.test("defaults: strict, full target set, production alert topic", async () => {
  const jobs = await evaluate({ skipSlow: "false" });
  const run = jobs.find((j) => j.name === "audit")!.steps[0].task.inputs!;
  assertEquals(run.strict, true);
  assertEquals(run.only, "");
  assertEquals(run.skipSlow, false);
  assertEquals(run.failOnError, true);
  const esc = jobs.find((j) => j.name === "escalate")!;
  assertEquals(esc.dependsOn, [{
    job: "audit",
    condition: { type: "failed" },
  }]);
  assertEquals(
    esc.steps[0].task.inputs!.url,
    "https://ntfy.oryx-herring.ts.net/alerts",
  );
});

Deno.test("on-demand inputs pass through", async () => {
  const jobs = await evaluate({
    only: "codex,claude",
    strict: "false",
    alertUrl: "",
  });
  const run = jobs.find((j) => j.name === "audit")!.steps[0].task.inputs!;
  assertEquals(run.only, "codex,claude");
  assertEquals(run.strict, false);
  assertEquals(
    jobs.find((j) => j.name === "escalate")!.steps[0].task.inputs!.url,
    "",
  );
});

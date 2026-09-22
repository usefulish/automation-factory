/**
 * Regression tests for the nixos-adopt workflow's evaluated form. These
 * drive the real `swamp workflow evaluate` — the same resolution path a
 * run uses — and pin the safety-critical CEL derivations:
 *
 *   - inspect mode never activates (ADOPT_INSPECT=1, approval skipped)
 *   - apply mode activates behind the approval gate (ADOPT_INSPECT=0)
 *   - reboot/reconnect only arm in apply mode with reboot=true
 *   - the flake ref, address derivation, and per-phase result wiring
 *
 * No SSH, no NixOS host — evaluation resolves expressions without
 * executing steps.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse as parseYaml } from "jsr:@std/yaml@1";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

interface Step {
  name: string;
  guard?: string;
  task: {
    inputs?: Record<string, unknown>;
    globalArgs?: Record<string, unknown>;
    type?: string;
  };
}

async function evaluate(
  inputs: Record<string, string>,
): Promise<Record<string, Step>> {
  const args = ["workflow", "evaluate", "nixos-adopt"];
  for (const [k, v] of Object.entries(inputs)) {
    // booleans/integers must be passed with the :json suffix so swamp
    // validates them as the right type (a bare string fails validation).
    const typed = v === "true" || v === "false" || /^\d+$/.test(v);
    args.push("--input", typed ? `${k}:json=${v}` : `${k}=${v}`);
  }
  const cmd = new Deno.Command("swamp", {
    args,
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr, success, code } = await cmd.output();
  const combined = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);
  assert(success, `evaluate failed (${code}):\n${combined}`);
  const m = combined.match(/Output: "(.+)"/);
  assert(m, `no evaluated output path in:\n${combined}`);
  const doc = parseYaml(await Deno.readTextFile(m[1])) as {
    jobs: { steps: Step[] }[];
  };
  const steps: Record<string, Step> = {};
  for (const s of doc.jobs[0].steps) steps[s.name] = s;
  return steps;
}

function cmd(step: Step): string {
  return String(step.task.inputs?.command ?? "");
}
function env(step: Step): Record<string, string> {
  return (step.task.inputs?.env ?? {}) as Record<string, string>;
}

Deno.test("inspect mode (default) never activates the host", async () => {
  const s = await evaluate({ host: "bao" });
  // apply step runs the driver in dry-run mode
  assert(
    cmd(s.apply).startsWith("ADOPT_INSPECT=1 "),
    `apply must be a dry run in inspect mode: ${cmd(s.apply)}`,
  );
  // reboot/reconnect are disarmed
  assertEquals(env(s["reboot-trigger"]).DO, "false");
  assertEquals(env(s.reconnect).DO, "false");
  // receipt records the mode
  assertEquals(env(s.receipt).ADOPT_MODE, "inspect");
  assertEquals(env(s.receipt).ADOPT_REBOOT, "false");
});

Deno.test("apply mode activates behind the approval gate", async () => {
  const s = await evaluate({ host: "bao", mode: "apply", applyMode: "switch" });
  assert(
    cmd(s.apply).startsWith("ADOPT_INSPECT=0 "),
    `apply must activate in apply mode: ${cmd(s.apply)}`,
  );
  assert(cmd(s.apply).includes("--mode switch"));
  // approval and accept-assertion guards are the inspect predicate — they
  // fire (do NOT skip) in apply mode.
  assertEquals(s.approve.guard, '${{ inputs.mode == "inspect" }}');
  assertEquals(s["assert-accept"].guard, '${{ inputs.mode == "inspect" }}');
  assertEquals(s.approve.task.type, "manual_approval");
});

Deno.test("apply mode honors applyMode=test (activate, no bootloader)", async () => {
  const s = await evaluate({ host: "bao", mode: "apply", applyMode: "test" });
  assert(cmd(s.apply).includes("--mode test"), cmd(s.apply));
});

Deno.test("reboot + reconnect arm only in apply mode with reboot=true", async () => {
  const s = await evaluate({ host: "bao", mode: "apply", reboot: "true" });
  assertEquals(env(s["reboot-trigger"]).DO, "true");
  assertEquals(env(s.reconnect).DO, "true");
  assertEquals(env(s.receipt).ADOPT_REBOOT, "true");

  // reboot=true but inspect mode must NOT reboot (safety)
  const s2 = await evaluate({ host: "bao", reboot: "true" }); // mode defaults inspect
  assertEquals(env(s2["reboot-trigger"]).DO, "false");
  assertEquals(env(s2.reconnect).DO, "false");
});

Deno.test("flake ref and address derive correctly", async () => {
  const s = await evaluate({ host: "gyoza" });
  for (const phase of ["discover", "plan", "apply", "accept"]) {
    assert(
      cmd(s[phase]).includes('"/tmp/nix-config#gyoza"'),
      `${phase} flake ref: ${cmd(s[phase])}`,
    );
  }
  // default address is <host>.<tailnet>
  const ga = s.discover.task.globalArgs as {
    hosts: { address: string }[];
  };
  assertEquals(ga.hosts[0].address, "gyoza.oryx-herring.ts.net");
});

Deno.test("explicit address overrides the tailnet derivation", async () => {
  const s = await evaluate({ host: "bao", address: "192.168.1.50" });
  const ga = s.discover.task.globalArgs as { hosts: { address: string }[] };
  assertEquals(ga.hosts[0].address, "192.168.1.50");
  assertEquals(env(s.reconnect).ADDR, "192.168.1.50");
});

Deno.test("receipt wires all four phase results plus reconnect", async () => {
  const s = await evaluate({ host: "bao" });
  const e = env(s.receipt);
  for (
    const k of ["ADOPT_DISCOVER", "ADOPT_PLAN", "ADOPT_APPLY", "ADOPT_ACCEPT"]
  ) {
    assert(k in e, `receipt missing ${k}`);
  }
  assert("ADOPT_REBOOT_RESULT" in e);
});

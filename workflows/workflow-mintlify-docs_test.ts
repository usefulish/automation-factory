/**
 * Regression tests for derived Swamp identifiers in the mintlify-docs
 * workflow.
 *
 * The `ready-to-commit` step derives a `@swamp/git` model name from the `repo`
 * input. Swamp definition names must be lowercase alphanumeric with hyphens
 * or underscores, while repository identities keep their real spelling
 * (`guru/AIrchaeology`, `usefulish/itinerary.fm`) for paths and data slugs.
 * These tests evaluate the real workflow through the swamp CLI — the same
 * resolution path a run uses — and pin the canonicalization on both sides of
 * that contract.
 *
 * History: uppercase repo names produced invalid definition names (run
 * c5ee3416, 2026-09-20); dots in repo names were handled before that but only
 * for the name segment, not the owner.
 *
 * @module
 */

import { assert, assertEquals } from "jsr:@std/assert@1";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** A name swamp accepts as a definition identifier. */
const VALID_DEFINITION_NAME = /^[a-z0-9][a-z0-9_-]*$/;

interface EvaluatedWorkflow {
  /** Path of the evaluated YAML the CLI wrote. */
  path: string;
  /** The evaluated YAML text. */
  text: string;
}

/** Evaluate the workflow with the given inputs and read the result. */
async function evaluateWorkflow(
  inputs: Record<string, string>,
): Promise<EvaluatedWorkflow> {
  const args = ["workflow", "evaluate", "@usefulish/mintlify-docs"];
  for (const [key, value] of Object.entries(inputs)) {
    args.push("--input", `${key}=${value}`);
  }

  const command = new Deno.Command("swamp", {
    args,
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr, success, code } = await command.output();
  const combined = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);

  assert(
    success,
    `swamp workflow evaluate failed (${code}):\n${combined}`,
  );

  const output = combined.match(/Output: "(.+)"/);
  assert(
    output !== null,
    `could not find evaluated output path in:\n${combined}`,
  );
  const text = await Deno.readTextFile(output[1]);
  return { path: output[1], text };
}

/** The ready-to-commit model name the workflow derived, or null. */
function derivedStatusModelName(text: string): string | null {
  const match = text.match(/^(\s*)modelName: (docs-checkout-status-\S+)$/m);
  return match === null ? null : match[2];
}

/** The workspace checkout path the workflow derived, or null. */
function derivedCheckoutPath(text: string): string | null {
  const match = text.match(
    /path: (\.swamp\/mintlify\/workspaces\/[^\s\n]+)/,
  );
  return match === null ? null : match[1];
}

Deno.test("uppercase repo identities canonicalize to valid definition names", async () => {
  const { text } = await evaluateWorkflow({ repo: "guru/AIrchaeology" });

  const name = derivedStatusModelName(text);
  assertEquals(name, "docs-checkout-status-guru-airchaeology");
  assert(
    name !== null && VALID_DEFINITION_NAME.test(name),
    `${name} is not a valid swamp definition name`,
  );

  // Identity semantics are preserved: paths keep the repository's real
  // spelling, only the identifier is normalized.
  assertEquals(
    derivedCheckoutPath(text),
    ".swamp/mintlify/workspaces/guru/AIrchaeology",
  );
});

Deno.test("dotted repo names keep their dot-to-hyphen canonicalization", async () => {
  const { text } = await evaluateWorkflow({ repo: "usefulish/itinerary.fm" });

  const name = derivedStatusModelName(text);
  assertEquals(name, "docs-checkout-status-usefulish-itinerary-fm");
  assertEquals(
    derivedCheckoutPath(text),
    ".swamp/mintlify/workspaces/usefulish/itinerary.fm",
  );
});

Deno.test("mixed-case, dotted, and dashed identities canonicalize together", async () => {
  const { text } = await evaluateWorkflow({
    repo: "Usefulish/Mac-Dependency-Safety",
  });

  const name = derivedStatusModelName(text);
  assertEquals(name, "docs-checkout-status-usefulish-mac-dependency-safety");
  assert(
    name !== null && VALID_DEFINITION_NAME.test(name),
    `${name} is not a valid swamp definition name`,
  );
  assertEquals(
    derivedCheckoutPath(text),
    ".swamp/mintlify/workspaces/Usefulish/Mac-Dependency-Safety",
  );
});

Deno.test("every status model name a run can derive is a valid definition name", async () => {
  const identities = [
    "guru/AIrchaeology",
    "usefulish/mac-dependency-safety",
    "usefulish/itinerary.fm",
    "acme/widgets.io",
    "Acme/Widgets.IO",
  ];
  for (const repo of identities) {
    const { text } = await evaluateWorkflow({ repo });
    const name = derivedStatusModelName(text);
    assert(
      name !== null && VALID_DEFINITION_NAME.test(name),
      `${repo} derived "${name}", which is not a valid swamp definition name`,
    );
  }
});

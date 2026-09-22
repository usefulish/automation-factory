/**
 * Unit tests for the A2A conformance model's pure logic: suite argv, report
 * normalisation (including the "never green without evidence" rules), the
 * production-surface guards ported from knowfleet #400/#412, alert text, and
 * the report renderer. No suite, edges, Keychain, or ntfy involved.
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  alertAllowed,
  alertMessage,
  buildSuiteArgs,
  DEFAULT_HEARTBEAT,
  DEFAULT_SUITE,
  heartbeatTarget,
  parseOnly,
  PROD_ALERT_URL,
  summarize,
  type TargetResult,
} from "./_lib/summary.ts";
import { renderRun } from "./a2a_conformance_summary.ts";

const target = (
  name: string,
  kind: "edge" | "reference",
  statuses: Array<"pass" | "fail" | "inconclusive">,
): TargetResult => ({
  name,
  kind,
  url: "http://127.0.0.1:1",
  ms: 1000,
  passed: statuses.filter((s) => s === "pass").length,
  failed: statuses.filter((s) => s === "fail").length,
  inconclusive: statuses.filter((s) => s === "inconclusive").length,
  results: statuses.map((status, i) => ({
    probe: `probe.${i}`,
    status,
    detail: status === "fail" ? "boom" : "fine",
  })),
});

const base = {
  exitCode: 0,
  timedOut: false,
  stderr: "",
  strict: true,
  only: [] as string[],
  skipSlow: false,
  suitePath: DEFAULT_SUITE,
  startedAt: "2026-09-22T00:00:00Z",
  finishedAt: "2026-09-22T00:05:00Z",
};

Deno.test("parseOnly splits, trims, dedupes", () => {
  assertEquals(parseOnly(" codex, claude  codex,"), ["codex", "claude"]);
  assertEquals(parseOnly(""), []);
  assertEquals(parseOnly(undefined), []);
});

Deno.test("buildSuiteArgs maps every option and repeats --only", () => {
  assertEquals(
    buildSuiteArgs({
      only: ["codex", "pi"],
      strict: true,
      skipSlow: true,
      jsonPath: "/t/r.json",
    }),
    [
      "--json",
      "/t/r.json",
      "--only",
      "codex",
      "--only",
      "pi",
      "--strict",
      "--skip-slow",
    ],
  );
  assertEquals(
    buildSuiteArgs({ only: [], strict: false, skipSlow: false, jsonPath: "x" }),
    ["--json", "x"],
  );
});

Deno.test("summarize: green report with exit 0 is ok", () => {
  const run = summarize({
    ...base,
    report: {
      ok: true,
      gate: "all targets",
      cliCommit: "a2a-cli-1e29dfe",
      targets: [
        target("codex-kimchi", "edge", ["pass", "pass"]),
        target("librarian-kimchi", "reference", ["pass", "inconclusive"]),
      ],
    },
  });
  assert(run.ok);
  assertEquals(run.error, null);
  assertEquals(run.totals, {
    targets: 2,
    failedTargets: 0,
    probes: 4,
    failedProbes: 0,
    inconclusive: 1,
  });
  assertEquals(run.injected, false);
});

Deno.test("summarize: no report is a crash, never ok", () => {
  const run = summarize({
    ...base,
    report: null,
    exitCode: 1,
    stderr: "line1\nsecurity: item not found\n",
  });
  assert(!run.ok);
  assert(run.crashed);
  assertStringIncludes(run.error!, "security: item not found");
});

Deno.test("summarize: exit 0 without a report is still not ok", () => {
  const run = summarize({ ...base, report: null, exitCode: 0 });
  assert(!run.ok);
  assert(run.crashed);
});

Deno.test("summarize: report ok but non-zero exit is a failure", () => {
  const run = summarize({
    ...base,
    exitCode: 1,
    report: { ok: true, targets: [target("codex-kimchi", "edge", ["pass"])] },
  });
  assert(!run.ok);
  assertStringIncludes(run.error!, "disagrees");
});

Deno.test("summarize: an empty target list never passes", () => {
  const run = summarize({ ...base, report: { ok: true, targets: [] } });
  assert(!run.ok);
  assertEquals(run.error, "suite ran no targets");
});

Deno.test("summarize: timeout is a crash", () => {
  const run = summarize({
    ...base,
    report: null,
    exitCode: 124,
    timedOut: true,
  });
  assert(run.crashed);
  assertEquals(run.error, "suite timed out");
});

Deno.test("heartbeat: full production run writes it", () => {
  assertEquals(
    heartbeatTarget({ only: [], injected: false }, DEFAULT_HEARTBEAT).path,
    DEFAULT_HEARTBEAT,
  );
});

Deno.test("heartbeat: subset runs never write it", () => {
  assertEquals(
    heartbeatTarget({ only: ["codex"], injected: false }, DEFAULT_HEARTBEAT)
      .path,
    null,
  );
});

Deno.test("heartbeat: injected runs refuse the production dir (#412)", () => {
  const hb = heartbeatTarget({ only: [], injected: true }, DEFAULT_HEARTBEAT);
  assertEquals(hb.path, null);
  assertStringIncludes(hb.reason, "#412");
  // ...but may write a scratch heartbeat, so the path is still exercisable.
  assertEquals(
    heartbeatTarget({ only: [], injected: true }, "/tmp/x.heartbeat").path,
    "/tmp/x.heartbeat",
  );
});

Deno.test("alert: injected runs refuse the production topic (#400)", () => {
  assert(!alertAllowed({ injected: true }, PROD_ALERT_URL).allowed);
  assert(!alertAllowed({ injected: true }, PROD_ALERT_URL + "/").allowed);
  assert(alertAllowed({ injected: true }, "http://127.0.0.1:9/t").allowed);
  assert(alertAllowed({ injected: false }, PROD_ALERT_URL).allowed);
  assert(!alertAllowed({ injected: false }, "").allowed);
});

Deno.test("alertMessage names failing targets and first failed probe", () => {
  const run = summarize({
    ...base,
    exitCode: 1,
    report: {
      ok: false,
      gate: "all targets",
      targets: [
        target("codex-kimchi", "edge", ["pass", "fail", "fail"]),
        target("pi-kimchi", "reference", ["pass"]),
      ],
    },
  });
  const m = alertMessage(run);
  assertEquals(m.title, "A2A conformance FAILED (all targets)");
  assertStringIncludes(m.body, "codex-kimchi (edge) 1/3 — probe.1: boom");
  assert(!m.body.includes("pi-kimchi"));
});

Deno.test("alertMessage for a crash says it did not run", () => {
  const m = alertMessage(
    summarize({ ...base, report: null, exitCode: 127, only: ["codex"] }),
  );
  assertEquals(m.title, "A2A conformance did not run [codex]");
});

Deno.test("renderRun lists non-pass probes and flags injection", () => {
  const run = summarize({
    ...base,
    suitePath: "/tmp/stub.mjs",
    exitCode: 1,
    report: {
      ok: false,
      gate: "all targets",
      targets: [target("claude-kimchi", "edge", ["fail", "inconclusive"])],
    },
  });
  const md = renderRun(run);
  assertStringIncludes(md, "## FAIL — gate: all targets");
  assertStringIncludes(md, "| claude-kimchi | edge | 0/2 | 1 | 1 |");
  assertStringIncludes(md, "**fail** probe.0: boom");
  assertStringIncludes(md, "**inconclusive** probe.1");
  assertStringIncludes(md, "Injected suite");
});

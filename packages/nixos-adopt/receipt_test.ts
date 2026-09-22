/**
 * Fixture-driven tests for the adoption receipt builder. No SSH, no swamp,
 * no NixOS host — the phase JSON fixtures are exactly the last-line output
 * that nix-config's scripts/adopt-nixos.sh emits, so this pins the contract
 * between the host-side driver and the operator-side receipt.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildReceipt,
  parsePhase,
  type Phase,
  type ReceiptContext,
  renderMarkdown,
} from "./receipt.ts";

// --- fixtures: verbatim phase JSON (with leading progress lines, as a real
// step's captured stdout would have) ---------------------------------------

const DISCOVER_READY =
  `== discover: read-only inspection of bao\n{"phase":"discover","host":"bao","observedHostname":"bao","arch":"x86_64","nixosVersion":"26.05.20260903.a5cc6f2 (Warbler)","currentToplevel":"/nix/store/aaa-nixos-system-bao","currentGeneration":"2","flakesEnabled":true,"wiredIntoFlake":true,"hardwareConfigOk":true,"hardwareConfigReason":"hardware-configuration.nix present with fileSystems","ready":true,"readyReason":"all prerequisites satisfied"}`;

const DISCOVER_NOT_READY =
  `{"phase":"discover","host":"bao","observedHostname":"bao","arch":"x86_64","nixosVersion":"26.05","currentToplevel":"/nix/store/aaa","currentGeneration":"2","flakesEnabled":false,"wiredIntoFlake":true,"hardwareConfigOk":false,"hardwareConfigReason":"placeholder","ready":false,"readyReason":"placeholder hw config; "}`;

const PLAN_DIFFERS =
  `{"phase":"plan","host":"bao","flakeRef":"/tmp/nix-config#bao","currentToplevel":"/nix/store/aaa-nixos-system-bao","targetToplevel":"/nix/store/bbb-nixos-system-bao","buildOk":true,"buildError":"","change":"differs"}`;

const PLAN_NONE =
  `{"phase":"plan","host":"bao","flakeRef":"/tmp/nix-config#bao","currentToplevel":"/nix/store/bbb-nixos-system-bao","targetToplevel":"/nix/store/bbb-nixos-system-bao","buildOk":true,"buildError":"","change":"none"}`;

const APPLY_SWITCHED =
  `{"phase":"apply","host":"bao","mode":"switch","flakeRef":"/tmp/nix-config#bao","beforeToplevel":"/nix/store/aaa-nixos-system-bao","afterToplevel":"/nix/store/bbb-nixos-system-bao","targetToplevel":"/nix/store/bbb-nixos-system-bao","beforeGeneration":"2","afterGeneration":"3","skipped":false,"applyOk":true,"applyError":"","rebootAdvised":false}`;

const APPLY_INSPECT =
  `{"phase":"apply","mode":"switch","host":"bao","flakeRef":"/tmp/nix-config#bao","beforeToplevel":"/nix/store/aaa","afterToplevel":"/nix/store/aaa","targetToplevel":"/nix/store/bbb","beforeGeneration":"2","afterGeneration":"2","skipped":true,"skipReason":"inspect","applyOk":true,"applyError":"","rebootAdvised":false}`;

const APPLY_REBOOT_ADVISED =
  `{"phase":"apply","host":"bao","mode":"switch","flakeRef":"/tmp/nix-config#bao","beforeToplevel":"/nix/store/aaa","afterToplevel":"/nix/store/ccc","targetToplevel":"/nix/store/ccc","beforeGeneration":"2","afterGeneration":"3","skipped":false,"applyOk":true,"applyError":"","rebootAdvised":true}`;

const ACCEPT_ALL_PASS =
  `{"phase":"accept","host":"bao","currentToplevel":"/nix/store/bbb-nixos-system-bao","targetToplevel":"/nix/store/bbb-nixos-system-bao","currentGeneration":"3","nixosVersion":"26.05.20260903.a5cc6f2 (Warbler)","allPass":true,"checks":[{"name":"current-system matches flake target","pass":true,"detail":"/nix/store/bbb-nixos-system-bao"},{"name":"hostname matches host attribute","pass":true,"detail":"bao"},{"name":"root account locked","pass":true,"detail":"passwd -S root: L"},{"name":"sleep-state targets masked","pass":true,"detail":"all masked"}]}`;

const ACCEPT_ONE_FAIL =
  `{"phase":"accept","host":"bao","currentToplevel":"/nix/store/bbb","targetToplevel":"/nix/store/bbb","currentGeneration":"3","nixosVersion":"26.05","allPass":false,"checks":[{"name":"current-system matches flake target","pass":true,"detail":"ok"},{"name":"sleep-state targets masked","pass":false,"detail":"suspend=enabled"}]}`;

function ctx(overrides: Partial<ReceiptContext> = {}): ReceiptContext {
  return {
    host: "bao",
    mode: "apply",
    flakeRevision: "eacc7b4",
    flakeDirty: false,
    rebootRequested: false,
    rebootResult: "not-requested",
    ...overrides,
  };
}

const NOT_RUN: Phase = { ran: false, raw: null };

Deno.test("parsePhase extracts the last JSON line from captured stdout", () => {
  const ph = parsePhase(DISCOVER_READY);
  assert(ph.ran);
  assertEquals(ph.raw?.host, "bao");
  assertEquals(ph.raw?.ready, true);
});

Deno.test("parsePhase treats absent/empty/garbage as not-run", () => {
  assertEquals(parsePhase(undefined).ran, false);
  assertEquals(parsePhase("").ran, false);
  assertEquals(parsePhase("   ").ran, false);
  const g = parsePhase("no json here\njust logs");
  assertEquals(g.ran, false);
  assert(g.parseError);
});

Deno.test("full apply run: identity, generation, config, checks, ok", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_DIFFERS),
    apply: parsePhase(APPLY_SWITCHED),
    accept: parsePhase(ACCEPT_ALL_PASS),
  }, ctx());

  assertEquals(r.identity.observedHostname, "bao");
  assertEquals(r.identity.arch, "x86_64");
  assertEquals(r.generation.start, "2");
  assertEquals(r.generation.end, "3");
  assertEquals(r.configuration.change, "differs");
  assertEquals(r.configuration.applied, true);
  assertEquals(r.configuration.flakeRevision, "eacc7b4");
  assertEquals(r.checks.length, 4);
  assertEquals(r.checksPassed, true);
  assertEquals(r.ok, true);
  assertEquals(r.deviations.length, 0);
  // apply mode always carries the manual tailscale + role follow-ups
  assert(r.followUps.some((f) => f.includes("Tailscale")));
  assert(r.followUps.some((f) => f.includes("Role-specific")));
});

Deno.test("discover not-ready fails the receipt (gate before any change)", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_NOT_READY),
    plan: NOT_RUN,
    apply: NOT_RUN,
    accept: NOT_RUN,
  }, ctx());
  assertEquals(r.ok, false);
  assertEquals(r.phasesRun, ["discover"]);
});

Deno.test("a failed acceptance check becomes a deviation and fails ok", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_NONE),
    apply: parsePhase(APPLY_SWITCHED),
    accept: parsePhase(ACCEPT_ONE_FAIL),
  }, ctx());
  assertEquals(r.checksPassed, false);
  assertEquals(r.ok, false);
  assert(
    r.deviations.some((d) => d.includes("sleep-state targets masked")),
    "failed check should appear in deviations",
  );
});

Deno.test("inspect mode: differing host is a follow-up, not a failure", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_DIFFERS),
    apply: parsePhase(APPLY_INSPECT),
    accept: NOT_RUN,
  }, ctx({ mode: "inspect" }));
  assertEquals(r.configuration.applySkipped, true);
  assertEquals(r.configuration.applySkipReason, "inspect");
  assertEquals(r.ok, true); // drift in inspect mode is not a failure
  assert(
    r.followUps.some((f) => f.includes("rerun with mode=apply")),
    "inspect mode should advise rerunning to converge",
  );
  // inspect mode does NOT emit the apply-only manual follow-ups
  assert(!r.followUps.some((f) => f.includes("Tailscale")));
});

Deno.test("reboot advised but not requested surfaces a follow-up", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_DIFFERS),
    apply: parsePhase(APPLY_REBOOT_ADVISED),
    accept: parsePhase(ACCEPT_ALL_PASS),
  }, ctx({ rebootRequested: false }));
  assertEquals(r.reboot.advised, true);
  assert(
    r.followUps.some((f) => f.includes("advised a reboot")),
    "should advise operator to reboot",
  );
});

Deno.test("dirty flake tree is recorded as a deviation", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_DIFFERS),
    apply: parsePhase(APPLY_SWITCHED),
    accept: parsePhase(ACCEPT_ALL_PASS),
  }, ctx({ flakeDirty: true }));
  assert(
    r.deviations.some((d) => d.includes("dirty")),
    "dirty tree should be a deviation",
  );
});

Deno.test("idempotent rerun: plan=none, apply skipped, still ok", () => {
  const APPLY_SKIP_CONVERGED =
    `{"phase":"apply","host":"bao","mode":"switch","flakeRef":"/tmp/nix-config#bao","beforeToplevel":"/nix/store/bbb","afterToplevel":"/nix/store/bbb","targetToplevel":"/nix/store/bbb","beforeGeneration":"3","afterGeneration":"3","skipped":true,"applyOk":true,"applyError":"","rebootAdvised":false}`;
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_NONE),
    apply: parsePhase(APPLY_SKIP_CONVERGED),
    accept: parsePhase(ACCEPT_ALL_PASS),
  }, ctx());
  assertEquals(r.configuration.change, "none");
  assertEquals(r.configuration.applySkipped, true);
  assertEquals(r.configuration.applied, false); // skipped == not newly applied
  assertEquals(r.ok, true);
});

Deno.test("renderMarkdown produces a complete receipt document", () => {
  const r = buildReceipt({
    discover: parsePhase(DISCOVER_READY),
    plan: parsePhase(PLAN_DIFFERS),
    apply: parsePhase(APPLY_SWITCHED),
    accept: parsePhase(ACCEPT_ALL_PASS),
  }, ctx());
  const md = renderMarkdown(r);
  assert(md.includes("# NixOS adoption receipt — bao"));
  assert(md.includes("## Identity"));
  assert(md.includes("## Configuration applied"));
  assert(md.includes("## Checks"));
  assert(md.includes("## Reboot / reconnect"));
  assert(md.includes("## Deviations"));
  assert(md.includes("## Operator follow-ups"));
  assert(md.includes("| Check | Result | Detail |"));
});

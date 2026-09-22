#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * Assemble a structured adoption receipt from the per-phase JSON emitted
 * by nix-config's scripts/adopt-nixos.sh (discover / plan / apply /
 * accept), plus operator-side facts the host cannot know (the flake git
 * revision and working-tree cleanliness) and the reboot/reconnect result.
 *
 * The workflow feeds each phase's last-line JSON in through an environment
 * variable; this module parses them defensively (absent, empty, or
 * non-JSON phases are recorded as "not run" rather than crashing the
 * receipt) and emits:
 *
 *   - a machine-readable JSON receipt (stdout, and --out <file> if given)
 *   - a human-readable Markdown summary (--md <file> if given)
 *
 * The receipt is the audit artifact required by the task: host identity,
 * architecture, starting/ending generation, config/flake revision applied,
 * every check and its result, the reboot/reconnect outcome, deviations,
 * and operator follow-ups.
 *
 * It is pure over its inputs (env + args) so it can be unit-tested against
 * fixtures with no SSH, no swamp, and no NixOS host. See receipt_test.ts.
 *
 * @module
 */

/** A single acceptance check as emitted by the accept phase. */
export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Parsed, normalized view of one phase's JSON (or a "not run" marker). */
export interface Phase {
  ran: boolean;
  raw: Record<string, unknown> | null;
  parseError?: string;
}

/** Operator-side facts and run parameters not visible to the host. */
export interface ReceiptContext {
  host: string;
  mode: string; // "inspect" | "apply"
  flakeRevision: string;
  flakeDirty: boolean;
  rebootRequested: boolean;
  rebootResult: string; // free-form: "not-requested" | "rebooted+reconnected" | "reconnect-timeout" | ...
}

/** The assembled receipt. */
export interface Receipt {
  schema: "nixos-adopt/receipt@1";
  generatedAt: string;
  host: string;
  mode: string;
  identity: {
    requestedHost: string;
    observedHostname: string | null;
    arch: string | null;
    nixosVersion: string | null;
  };
  generation: {
    start: string | null;
    end: string | null;
  };
  configuration: {
    flakeRevision: string;
    flakeDirty: boolean;
    flakeRef: string | null;
    startToplevel: string | null;
    endToplevel: string | null;
    targetToplevel: string | null;
    change: string | null; // none | differs | unknown
    applied: boolean;
    applySkipped: boolean;
    applySkipReason: string | null;
  };
  checks: Check[];
  checksPassed: boolean | null;
  reboot: {
    requested: boolean;
    advised: boolean | null;
    result: string;
  };
  deviations: string[];
  followUps: string[];
  phasesRun: string[];
  ok: boolean;
}

/** Parse one phase env var into a Phase, never throwing. */
export function parsePhase(value: string | undefined): Phase {
  const text = (value ?? "").trim();
  if (text === "") return { ran: false, raw: null };
  // The workflow may hand us the whole step stdout; take the last JSON line.
  const line = lastJsonLine(text);
  if (line === null) {
    return { ran: false, raw: null, parseError: "no JSON object found" };
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return { ran: true, raw: obj };
  } catch (e) {
    return {
      ran: false,
      raw: null,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Find the last line that parses as a JSON object. */
function lastJsonLine(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) =>
    l.startsWith("{") && l.endsWith("}")
  );
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function str(o: Record<string, unknown> | null, k: string): string | null {
  if (!o) return null;
  const v = o[k];
  return typeof v === "string" && v !== "" ? v : null;
}
function bool(
  o: Record<string, unknown> | null,
  k: string,
): boolean | null {
  if (!o) return null;
  const v = o[k];
  return typeof v === "boolean" ? v : null;
}

/** Build the receipt from the four phases and operator context. */
export function buildReceipt(
  phases: {
    discover: Phase;
    plan: Phase;
    apply: Phase;
    accept: Phase;
  },
  ctx: ReceiptContext,
  now: Date = new Date(),
): Receipt {
  const d = phases.discover.raw;
  const p = phases.plan.raw;
  const a = phases.apply.raw;
  const ac = phases.accept.raw;

  const checks: Check[] = Array.isArray(ac?.checks)
    ? (ac!.checks as unknown[]).filter((c): c is Check =>
      !!c && typeof c === "object" && "name" in c && "pass" in c
    ).map((c) => ({
      name: String((c as Check).name),
      pass: Boolean((c as Check).pass),
      detail: String((c as Check).detail ?? ""),
    }))
    : [];

  const phasesRun: string[] = [];
  for (const [name, ph] of Object.entries(phases)) {
    if (ph.ran) phasesRun.push(name);
  }

  const deviations: string[] = [];
  const followUps: string[] = [];

  // Deviations: failed checks, parse errors, dirty tree, drift left unapplied.
  for (const ph of Object.entries(phases)) {
    if (ph[1].parseError) {
      deviations.push(`phase ${ph[0]} output unparseable: ${ph[1].parseError}`);
    }
  }
  for (const c of checks) {
    if (!c.pass) deviations.push(`check failed: ${c.name} — ${c.detail}`);
  }
  if (ctx.flakeDirty) {
    deviations.push(
      "flake working tree was dirty at apply time — applied config may not match any committed revision",
    );
  }
  const change = str(p, "change");
  const applySkipped = bool(a, "skipped") ?? false;
  if (
    ctx.mode === "inspect" && change === "differs"
  ) {
    followUps.push(
      "inspect mode: host differs from the flake target — rerun with mode=apply to converge it",
    );
  }
  const rebootAdvised = bool(a, "rebootAdvised");
  if (rebootAdvised && !ctx.rebootRequested) {
    followUps.push(
      "apply advised a reboot (kernel/initrd or bootloader changed) but reboot was not requested — reboot the host and rerun accept",
    );
  }
  // Standing manual follow-ups the workflow deliberately never automates.
  if (ctx.mode !== "inspect") {
    followUps.push(
      "Tailscale enrollment is manual and never automated: if this host is new to the tailnet, run `sudo tailscale up` then `sudo tailscale set --hostname=" +
        ctx.host + " --ssh` on the host (no auth keys in the repo/store)",
    );
    followUps.push(
      "Role-specific configuration (host-local services) is applied separately — this workflow yields a baseline fleet member only",
    );
  }

  const discoverReady = bool(d, "ready");
  const buildOk = bool(p, "buildOk");
  const applyOk = bool(a, "applyOk");
  const checksPassed = ac ? (bool(ac, "allPass")) : null;

  // Overall ok: every phase that ran succeeded at its own job. In inspect
  // mode, "apply" is a dry run and accept is read-only, so a differing host
  // is not a failure — only genuine errors are.
  let ok = true;
  if (phases.discover.ran && discoverReady === false) ok = false;
  if (phases.plan.ran && buildOk === false) ok = false;
  if (phases.apply.ran && applyOk === false) ok = false;
  if (ctx.mode !== "inspect" && phases.accept.ran && checksPassed === false) {
    ok = false;
  }

  return {
    schema: "nixos-adopt/receipt@1",
    generatedAt: now.toISOString(),
    host: ctx.host,
    mode: ctx.mode,
    identity: {
      requestedHost: ctx.host,
      observedHostname: str(d, "observedHostname") ??
        str(ac, "host"),
      arch: str(d, "arch"),
      nixosVersion: str(d, "nixosVersion") ?? str(ac, "nixosVersion"),
    },
    generation: {
      start: str(d, "currentGeneration") ?? str(a, "beforeGeneration"),
      end: str(ac, "currentGeneration") ?? str(a, "afterGeneration") ??
        str(a, "beforeGeneration"),
    },
    configuration: {
      flakeRevision: ctx.flakeRevision,
      flakeDirty: ctx.flakeDirty,
      flakeRef: str(p, "flakeRef") ?? str(a, "flakeRef"),
      startToplevel: str(d, "currentToplevel") ?? str(a, "beforeToplevel"),
      endToplevel: str(ac, "currentToplevel") ?? str(a, "afterToplevel"),
      targetToplevel: str(p, "targetToplevel") ?? str(a, "targetToplevel"),
      change,
      applied: applyOk === true && applySkipped === false,
      applySkipped,
      applySkipReason: str(a, "skipReason"),
    },
    checks,
    checksPassed,
    reboot: {
      requested: ctx.rebootRequested,
      advised: rebootAdvised,
      result: ctx.rebootResult,
    },
    deviations,
    followUps,
    phasesRun,
    ok,
  };
}

/** Render the receipt as Markdown. */
export function renderMarkdown(r: Receipt): string {
  const yn = (b: boolean | null) => b === null ? "—" : b ? "yes" : "no";
  const lines: string[] = [];
  lines.push(`# NixOS adoption receipt — ${r.host}`);
  lines.push("");
  lines.push(`- Generated: ${r.generatedAt}`);
  lines.push(`- Mode: **${r.mode}**`);
  lines.push(`- Overall: **${r.ok ? "OK" : "ATTENTION NEEDED"}**`);
  lines.push(`- Phases run: ${r.phasesRun.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("## Identity");
  lines.push(`- Requested host: ${r.identity.requestedHost}`);
  lines.push(`- Observed hostname: ${r.identity.observedHostname ?? "—"}`);
  lines.push(`- Architecture: ${r.identity.arch ?? "—"}`);
  lines.push(`- NixOS version: ${r.identity.nixosVersion ?? "—"}`);
  lines.push("");
  lines.push("## Configuration applied");
  lines.push(
    `- Flake revision: ${r.configuration.flakeRevision}${
      r.configuration.flakeDirty ? " (dirty tree)" : ""
    }`,
  );
  lines.push(`- Flake ref: ${r.configuration.flakeRef ?? "—"}`);
  lines.push(
    `- Generation: ${r.generation.start ?? "—"} → ${r.generation.end ?? "—"}`,
  );
  lines.push(`- Change: ${r.configuration.change ?? "—"}`);
  lines.push(
    `- Applied: ${yn(r.configuration.applied)}${
      r.configuration.applySkipped
        ? ` (skipped: ${
          r.configuration.applySkipReason ?? "already converged"
        })`
        : ""
    }`,
  );
  lines.push(`- Start toplevel: ${r.configuration.startToplevel ?? "—"}`);
  lines.push(`- End toplevel: ${r.configuration.endToplevel ?? "—"}`);
  lines.push(`- Target toplevel: ${r.configuration.targetToplevel ?? "—"}`);
  lines.push("");
  lines.push("## Checks");
  if (r.checks.length === 0) {
    lines.push("_No acceptance checks were run (e.g. inspect-only run)._");
  } else {
    lines.push("| Check | Result | Detail |");
    lines.push("| --- | --- | --- |");
    for (const c of r.checks) {
      lines.push(
        `| ${c.name} | ${c.pass ? "PASS" : "FAIL"} | ${
          c.detail.replace(/\|/g, "\\|")
        } |`,
      );
    }
    lines.push("");
    lines.push(`Checks passed: **${yn(r.checksPassed)}**`);
  }
  lines.push("");
  lines.push("## Reboot / reconnect");
  lines.push(`- Requested: ${yn(r.reboot.requested)}`);
  lines.push(`- Advised by apply: ${yn(r.reboot.advised)}`);
  lines.push(`- Result: ${r.reboot.result}`);
  lines.push("");
  lines.push("## Deviations");
  if (r.deviations.length === 0) {
    lines.push("_None._");
  } else {
    for (const dv of r.deviations) lines.push(`- ${dv}`);
  }
  lines.push("");
  lines.push("## Operator follow-ups");
  if (r.followUps.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of r.followUps) lines.push(`- ${f}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** CLI entrypoint: read phases from env, write JSON (+ optional MD). */
function main() {
  const env = Deno.env.toObject();
  const phases = {
    discover: parsePhase(env.ADOPT_DISCOVER),
    plan: parsePhase(env.ADOPT_PLAN),
    apply: parsePhase(env.ADOPT_APPLY),
    accept: parsePhase(env.ADOPT_ACCEPT),
  };
  const ctx: ReceiptContext = {
    host: env.ADOPT_HOST ?? "unknown",
    mode: env.ADOPT_MODE ?? "apply",
    flakeRevision: env.ADOPT_FLAKE_REV ?? "unknown",
    flakeDirty: env.ADOPT_FLAKE_DIRTY === "true" ||
      env.ADOPT_FLAKE_DIRTY === "1",
    rebootRequested: env.ADOPT_REBOOT === "true" || env.ADOPT_REBOOT === "1",
    rebootResult: (env.ADOPT_REBOOT_RESULT ?? "not-requested").trim() ||
      "not-requested",
  };

  // The prepare step writes a small meta file with the flake revision and
  // working-tree cleanliness (facts the host cannot know). Reading it here
  // avoids trying to parse JSON out of a captured stdout string in CEL.
  const args = Deno.args;
  const metaIdx = args.indexOf("--meta");
  if (metaIdx >= 0 && args[metaIdx + 1]) {
    try {
      const meta = JSON.parse(Deno.readTextFileSync(args[metaIdx + 1]));
      if (typeof meta.rev === "string" && meta.rev) {
        ctx.flakeRevision = meta.rev;
      }
      if (typeof meta.dirty === "boolean") ctx.flakeDirty = meta.dirty;
    } catch (_e) {
      // Missing/unreadable meta is not fatal — the receipt records "unknown".
    }
  }

  const receipt = buildReceipt(phases, ctx);
  const json = JSON.stringify(receipt, null, 2);

  const outIdx = args.indexOf("--out");
  const mdIdx = args.indexOf("--md");
  if (outIdx >= 0 && args[outIdx + 1]) {
    Deno.writeTextFileSync(args[outIdx + 1], json + "\n");
  }
  if (mdIdx >= 0 && args[mdIdx + 1]) {
    Deno.writeTextFileSync(args[mdIdx + 1], renderMarkdown(receipt));
  }
  console.log(json);
  // A non-ok receipt is still a successfully-produced receipt; the workflow
  // decides whether to fail. Exit 0 so the receipt always lands.
}

if (import.meta.main) main();

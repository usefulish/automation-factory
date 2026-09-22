/**
 * Unit tests for the audit-ledger pure core. These pin the guards that keep
 * the workflow from double-running a batch the cron polls already own, from
 * flooding the Sol pool, and from vouching for a run it did not make
 * (knowfleet task #453).
 *
 * @module
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  alertAllowed,
  alertMessage,
  type AuditPass,
  batchesOpenedOn,
  batchTriggerRef,
  dailyTriggerRef,
  DEFAULT_DB,
  DEFAULT_HEARTBEAT,
  dispatchAllowed,
  heartbeatTarget,
  isInjected,
  type LedgerSnapshot,
  nextUnopenedBatch,
  parseBatchManifest,
  planPass,
  PROD_ALERT_URL,
  type RunRow,
  stallState,
  tallyVerdicts,
  type VerdictRow,
} from "./_lib/ledger.ts";
import { cronOwner, ownerFrom } from "./_lib/cron.ts";
import { auditorPrompt, investigatorPrompt } from "./_lib/dispatch.ts";

const MANIFEST = `# #450 Reconciliation batch manifest

B1 [3]: eeb28ef8 37108366 3cf58555
B2 [2]: e3e926e3 e71ec129
B3 [1]: 900e8232

Ordering note: batches are by updated_at.
`;

function run(o: Partial<RunRow> & { id: string }): RunRow {
  return {
    startedAt: "2026-09-22T21:49:07.476Z",
    completedAt: null,
    status: "running",
    triggerRef: "",
    auditorProfile: "auditor",
    loop: 1,
    targets: 30,
    verdicts: 0,
    lastVerdictAt: null,
    ...o,
  };
}

function snapshot(o: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    at: "2026-09-23T00:00:00.000Z",
    runningRuns: [],
    recentRuns: [],
    dailyCandidates: [],
    verdictlessCandidates: [],
    openInvestigations: 0,
    dispatchableMr: [],
    ...o,
  };
}

const BATCHES = parseBatchManifest(MANIFEST);

Deno.test("manifest: parses batch lines and ignores prose", () => {
  assertEquals(BATCHES.length, 3);
  assertEquals(BATCHES[0].number, 1);
  assertEquals(BATCHES[0].of, 3);
  assertEquals(BATCHES[1].records, ["e3e926e3", "e71ec129"]);
});

Deno.test("manifest: a declared count that disagrees with the list is fatal", () => {
  assertThrows(
    () => parseBatchManifest("B1 [5]: aaaaaaaa bbbbbbbb\n"),
    Error,
    "refusing an ambiguous batch",
  );
});

// The load-bearing guard: B1 is running right now, and a pass must adopt it
// rather than open B2 alongside it (knowfleet #453 / lesson 14583002).
Deno.test("plan: a running run is adopted, never duplicated", () => {
  const b1 = run({
    id: "57bb7545-e70a-479f-aade-f5b3ef79f562",
    triggerRef: batchTriggerRef(BATCHES[0]),
  });
  const p = planPass({
    snapshot: snapshot({ runningRuns: [b1], recentRuns: [b1] }),
    batches: BATCHES,
    now: "2026-09-23T00:00:00.000Z",
  });
  assertEquals(p.action, "adopt");
  assertEquals(p.runId, b1.id);
  assertEquals(p.targets, []);
  assert(p.reason.includes("no new run is opened"));
});

Deno.test("plan: adopts a NON-daily running run too (lesson 14583002)", () => {
  const gate = run({ id: "7f664b47", triggerRef: "unblock #352 gate" });
  const p = planPass({
    snapshot: snapshot({ runningRuns: [gate], recentRuns: [gate] }),
    batches: BATCHES,
    now: "2026-09-23T00:00:00.000Z",
  });
  assertEquals(p.action, "adopt");
  assertEquals(p.runId, "7f664b47");
});

Deno.test("plan: adopts the OLDEST running run when several are in flight", () => {
  const older = run({ id: "older", startedAt: "2026-09-22T10:00:00.000Z" });
  const newer = run({ id: "newer", startedAt: "2026-09-22T20:00:00.000Z" });
  const p = planPass({
    snapshot: snapshot({
      runningRuns: [newer, older],
      recentRuns: [newer, older],
    }),
    batches: BATCHES,
    now: "2026-09-23T00:00:00.000Z",
  });
  assertEquals(p.runId, "older");
});

Deno.test("plan: opens the daily run when due, before any batch", () => {
  const p = planPass({
    snapshot: snapshot({ dailyCandidates: ["aaaaaaaa", "bbbbbbbb"] }),
    batches: BATCHES,
    now: "2026-09-23T14:00:00.000Z",
  });
  assertEquals(p.action, "open-daily");
  assertEquals(p.triggerRef, dailyTriggerRef("2026-09-23"));
  assertEquals(p.targets, ["aaaaaaaa", "bbbbbbbb"]);
});

Deno.test("plan: today's daily run already exists — moves on to the batch", () => {
  const daily = run({
    id: "d1",
    status: "completed",
    completedAt: "2026-09-23T15:00:00.000Z",
    startedAt: "2026-09-23T14:00:00.000Z",
    triggerRef: dailyTriggerRef("2026-09-23"),
  });
  const p = planPass({
    snapshot: snapshot({
      recentRuns: [daily],
      verdictlessCandidates: ["eeb28ef8", "37108366", "3cf58555"],
    }),
    batches: BATCHES,
    now: "2026-09-23T16:00:00.000Z",
  });
  assertEquals(p.action, "open-batch");
  assertEquals(p.batch?.number, 1);
});

// A batch whose records got verdicts by some other route must not park the
// reconciliation — the pass skips ahead to the next batch with real work.
Deno.test("plan: a fully-verdicted unopened batch is skipped, not parked on", () => {
  const p = planPass({
    snapshot: snapshot({ verdictlessCandidates: ["e3e926e3", "e71ec129"] }),
    batches: BATCHES,
    now: "2026-09-23T18:00:00.000Z",
    allowDaily: false,
  });
  assertEquals(p.action, "open-batch");
  assertEquals(p.batch?.number, 2);
  assertEquals(p.targets, ["e3e926e3", "e71ec129"]);
  assert(p.reason.includes("B1 already fully verdicted"));
});

Deno.test("plan: next unopened batch skips ones already in the ledger", () => {
  const b1 = run({
    id: "b1",
    status: "completed",
    triggerRef: batchTriggerRef(BATCHES[0]),
    startedAt: "2026-09-22T21:49:00.000Z",
  });
  assertEquals(nextUnopenedBatch(BATCHES, [b1])?.number, 2);
});

Deno.test("pacing: a third batch in one UTC day is refused", () => {
  const made = (n: number, id: string) =>
    run({
      id,
      status: "completed",
      startedAt: "2026-09-23T08:00:00.000Z",
      triggerRef: batchTriggerRef(BATCHES[n - 1]),
    });
  const recentRuns = [made(1, "b1"), made(2, "b2")];
  assertEquals(batchesOpenedOn(recentRuns, "2026-09-23"), 2);
  const p = planPass({
    snapshot: snapshot({
      recentRuns,
      verdictlessCandidates: ["900e8232"],
    }),
    batches: BATCHES,
    now: "2026-09-23T18:00:00.000Z",
    allowDaily: false,
  });
  assertEquals(p.action, "idle");
  assert(p.reason.includes("Sol pacing"));
  assertEquals(p.batchesToday, 2);
});

Deno.test("pacing: yesterday's batches do not count against today", () => {
  const yesterday = run({
    id: "b1",
    status: "completed",
    startedAt: "2026-09-22T21:49:00.000Z",
    triggerRef: batchTriggerRef(BATCHES[0]),
  });
  assertEquals(batchesOpenedOn([yesterday], "2026-09-23"), 0);
});

Deno.test("plan: records that gained a verdict since prep are dropped", () => {
  const b1 = run({
    id: "b1",
    status: "completed",
    startedAt: "2026-09-22T21:49:00.000Z",
    triggerRef: batchTriggerRef(BATCHES[0]),
  });
  // B2 lists e3e926e3 + e71ec129; only e71ec129 is still verdict-less.
  const p = planPass({
    snapshot: snapshot({
      recentRuns: [b1],
      verdictlessCandidates: ["e71ec129"],
    }),
    batches: BATCHES,
    now: "2026-09-23T18:00:00.000Z",
    allowDaily: false,
  });
  assertEquals(p.action, "open-batch");
  assertEquals(p.targets, ["e71ec129"]);
});

Deno.test("plan: when no batch has verdict-less records, nothing opens", () => {
  const p = planPass({
    snapshot: snapshot({ verdictlessCandidates: [] }),
    batches: BATCHES,
    now: "2026-09-23T18:00:00.000Z",
    allowDaily: false,
  });
  assertEquals(p.action, "idle");
  assert(p.reason.includes("already carries verdicts"));
});

Deno.test("plan: a caught-up ledger is idle, not a failure", () => {
  const opened = BATCHES.map((b, i) =>
    run({
      id: `b${i}`,
      status: "completed",
      startedAt: "2026-09-20T08:00:00.000Z",
      triggerRef: batchTriggerRef(b),
    })
  );
  const p = planPass({
    snapshot: snapshot({ recentRuns: opened }),
    batches: BATCHES,
    now: "2026-09-23T18:00:00.000Z",
    allowDaily: false,
  });
  assertEquals(p.action, "idle");
  assert(p.reason.includes("every #450 batch opened"));
});

Deno.test("dispatch: the auditor cron owning a run blocks a second worker", () => {
  const g = dispatchAllowed({
    cronOwned: true,
    stalled: false,
    dispatch: true,
  });
  assertEquals(g.allowed, false);
  assert(g.reason.includes("no-double-run"));
  assert(g.reason.includes("verdict authorship"));
});

// The same guard protects remediation, and must say so — an operator
// reading "owns verdict authorship" under the investigator would be
// reading the wrong story.
Deno.test("dispatch: the refusal names the role it is protecting", () => {
  const g = dispatchAllowed({
    cronOwned: true,
    stalled: false,
    dispatch: true,
    role: "remediation",
  });
  assertEquals(g.allowed, false);
  assert(g.reason.includes("remediation"));
  assert(!g.reason.includes("verdict authorship"));
});

Deno.test("owner: the ownership line names the role too", () => {
  const o = ownerFrom(
    [{ id: "63133383b02c", enabled: true, state: "scheduled" }],
    "63133383b02c",
    "remediation",
  );
  assert(o.reason.includes("owns remediation"));
});

Deno.test("dispatch: allowed when no cron owns the run", () => {
  assertEquals(
    dispatchAllowed({ cronOwned: false, stalled: false, dispatch: true })
      .allowed,
    true,
  );
});

Deno.test("dispatch: a stalled cron-owned run may be rescued", () => {
  const g = dispatchAllowed({ cronOwned: true, stalled: true, dispatch: true });
  assertEquals(g.allowed, true);
  assert(g.reason.includes("stall rescue"));
});

Deno.test("dispatch: disabled beats every other reason", () => {
  assertEquals(
    dispatchAllowed({ cronOwned: false, stalled: true, dispatch: false })
      .allowed,
    false,
  );
});

Deno.test("stall: a run within the cron budget is progressing", () => {
  const r = run({
    id: "x",
    targets: 30,
    verdicts: 4,
    lastVerdictAt: "2026-09-23T00:00:00.000Z",
  });
  const s = stallState(r, "2026-09-23T00:45:00.000Z");
  assertEquals(s.stalled, false);
  assertEquals(s.idleMinutes, 45);
});

Deno.test("stall: no verdict for 3+ auditor ticks is stalled", () => {
  const r = run({
    id: "x",
    targets: 30,
    verdicts: 4,
    lastVerdictAt: "2026-09-23T00:00:00.000Z",
  });
  const s = stallState(r, "2026-09-23T02:00:00.000Z");
  assertEquals(s.stalled, true);
  assert(s.reason.includes("4/30"));
});

Deno.test("stall: falls back to startedAt when no verdict has landed yet", () => {
  const r = run({
    id: "x",
    startedAt: "2026-09-23T00:00:00.000Z",
    targets: 30,
    verdicts: 0,
    lastVerdictAt: null,
  });
  assertEquals(stallState(r, "2026-09-23T03:00:00.000Z").stalled, true);
});

Deno.test("stall: a fully verdicted run is never stalled", () => {
  const r = run({
    id: "x",
    targets: 30,
    verdicts: 30,
    lastVerdictAt: "2026-09-20T00:00:00.000Z",
  });
  assertEquals(stallState(r, "2026-09-23T00:00:00.000Z").stalled, false);
});

Deno.test("tally: counts every verdict kind", () => {
  const vs = [
    { verdict: "retain" },
    { verdict: "retain" },
    { verdict: "machine-revisable" },
    { verdict: "needs-human" },
    { verdict: "reject" },
  ] as Pick<VerdictRow, "verdict">[];
  const t = tallyVerdicts(vs);
  assertEquals(t.retain, 2);
  assertEquals(t["machine-revisable"], 1);
  assertEquals(t["needs-human"], 1);
  assertEquals(t.reject, 1);
  assertEquals(t.total, 5);
});

Deno.test("injected: only the real ledger is production", () => {
  assertEquals(isInjected(DEFAULT_DB), false);
  assertEquals(isInjected("/tmp/fake.db"), true);
});

function pass(o: Partial<AuditPass> = {}): AuditPass {
  return {
    ok: true,
    crashed: false,
    error: null,
    action: "adopt",
    reason: "",
    dbPath: DEFAULT_DB,
    injected: false,
    dryRun: false,
    startedAt: "2026-09-23T00:00:00.000Z",
    finishedAt: "2026-09-23T00:01:00.000Z",
    runId: "57bb7545-e70a-479f-aade-f5b3ef79f562",
    triggerRef: null,
    targets: 30,
    verdicts: {
      retain: 0,
      "machine-revisable": 0,
      "needs-human": 0,
      reject: 0,
      total: 0,
    },
    completed: false,
    investigationsOpened: [],
    dispatch: { attempted: false, allowed: false, reason: "" },
    stall: null,
    batchesToday: 0,
    needsHuman: [],
    ...o,
  };
}

Deno.test("heartbeat: a real full pass writes it", () => {
  const h = heartbeatTarget(pass(), DEFAULT_HEARTBEAT);
  assertEquals(h.path, DEFAULT_HEARTBEAT);
});

Deno.test("heartbeat: a dry run never vouches for the scheduled job", () => {
  const h = heartbeatTarget(pass({ dryRun: true }), DEFAULT_HEARTBEAT);
  assertEquals(h.path, null);
  assert(h.reason.includes("dry run"));
});

Deno.test("heartbeat: an injected ledger cannot touch the production dir", () => {
  const h = heartbeatTarget(pass({ injected: true }), DEFAULT_HEARTBEAT);
  assertEquals(h.path, null);
  assert(h.reason.includes("#412"));
});

Deno.test("heartbeat: an injected pass may write outside the production dir", () => {
  const h = heartbeatTarget(pass({ injected: true }), "/tmp/hb");
  assertEquals(h.path, "/tmp/hb");
});

Deno.test("alert: an injected pass is refused the production topic", () => {
  const a = alertAllowed(pass({ injected: true }), PROD_ALERT_URL);
  assertEquals(a.allowed, false);
  assert(a.reason.includes("#400"));
});

Deno.test("alert: an empty url disables alerting", () => {
  assertEquals(alertAllowed(pass(), "").allowed, false);
});

Deno.test("alert: a crashed pass says no evidence, not a verdict count", () => {
  const m = alertMessage(
    pass({ crashed: true, ok: false, error: "ledger unreadable" }),
  );
  assert(m.title.includes("did not run"));
  assert(m.body.includes("ledger unreadable"));
});

Deno.test("alert: a stalled pass names the stall, not a generic failure", () => {
  const m = alertMessage(pass({
    ok: false,
    stall: { stalled: true, idleMinutes: 120, reason: "no verdict for 120m" },
  }));
  assert(m.title.includes("stalled"));
  assert(m.body.includes("no verdict for 120m"));
});

Deno.test("alert: needs-human verdicts reach the human", () => {
  const m = alertMessage(pass({
    ok: false,
    verdicts: {
      retain: 1,
      "machine-revisable": 0,
      "needs-human": 2,
      reject: 0,
      total: 3,
    },
    needsHuman: ["aaaaaaaa", "bbbbbbbb"],
  }));
  assert(m.body.includes("guru decision"));
  assert(m.body.includes("aaaaaaaa"));
});

// --- cron ownership: the hand-off that prevents a second driver ----------

Deno.test("owner: an active cron owns verdict authorship", () => {
  const o = ownerFrom(
    [{ id: "883029b254e4", enabled: true, state: "scheduled" }],
    "883029b254e4",
  );
  assertEquals(o.owned, true);
  assert(o.reason.includes("owns verdict authorship"));
});

Deno.test("owner: a paused cron hands the loop to the workflow", () => {
  const o = ownerFrom(
    [{ id: "883029b254e4", enabled: true, state: "paused", paused_at: "x" }],
    "883029b254e4",
  );
  assertEquals(o.owned, false);
  assert(o.reason.includes("paused"));
});

Deno.test("owner: a disabled cron hands the loop to the workflow", () => {
  const o = ownerFrom(
    [{ id: "883029b254e4", enabled: false }],
    "883029b254e4",
  );
  assertEquals(o.owned, false);
});

Deno.test("owner: a missing job is not an owner", () => {
  assertEquals(ownerFrom([], "883029b254e4").owned, false);
});

// An unreadable jobs file must fail CLOSED — assuming "nobody owns this"
// would licence exactly the duplicate dispatch this guard exists to stop.
Deno.test("owner: an unreadable jobs file is treated as owned", async () => {
  const o = await cronOwner("/nonexistent/jobs.json", "883029b254e4");
  assertEquals(o.owned, true);
  assert(o.reason.includes("assuming the cron owns"));
});

// --- dispatch prompts: the orchestrator asks, it never classifies --------

Deno.test("auditor prompt: names the run and forbids completing it", () => {
  const p = auditorPrompt("57bb7545-e70a-479f-aade-f5b3ef79f562");
  assert(p.includes("57bb7545-e70a-479f-aade-f5b3ef79f562"));
  assert(p.includes("Do NOT complete the run"));
  assert(p.includes("retain | machine-revisable | needs-human | reject"));
  assert(p.includes("context_begin"));
  assert(p.includes("never write SQLite directly"));
});

Deno.test("investigator prompt: governed surface only, never self-approve", () => {
  const p = investigatorPrompt(19, "e48410b2");
  assert(p.includes("investigation 19"));
  assert(p.includes("e48410b2"));
  assert(p.includes("knowledge_supersede"));
  assert(p.includes("Never self-approve"));
});

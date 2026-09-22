# @usefulish/audit-ledger

One deterministic pass over the knowfleet **audit ledger** and **investigation
dispatch** (knowfleet task #453), as a swamp extension model plus the
`audit-ledger` workflow.

A pass surveys the ledger, decides what it may do, opens or adopts exactly one
audit run, makes sure that run is being worked, completes it when every target
carries a verdict, and opens investigations for the machine-revisable ones. The
verdict of the pass is kept as versioned data (`lastPass`) with a rendered
report, and a failed, stalled, or needs-human pass escalates to ntfy.

## What it will not do

Three boundaries are structural, not stylistic. They are the reason this can run
beside the live cron polls without anyone getting hurt.

**It never drives a run twice.** A run already `running` is _adopted_, never
duplicated, and nothing new is opened while one is in flight — for _any_ running
run, not just the daily ones (lesson 14583002, whose whole point was that a
daily-only filter hid the reconciliation batches). On top of that, while the
auditor cron `883029b254e4` is enabled it **owns** verdict authorship, so this
model will not dispatch a second auditor onto a run it owns. A run that has
stopped progressing for three cron ticks is a _stall_ — it escalates to a human,
it does not silently start a competing worker.

Handing the loop over is a one-liner with no change here:

```bash
hermes -p auditor cron pause 883029b254e4     # workflow now owns authorship
swamp workflow run audit-ledger --input dispatch:json=true
```

**It never stamps a verdict.** The audit-loop contract gives classification to
the Auditor and remediation to the Investigator; the coordinator does neither.
This model has no `audit_verdict_add` path at all. Verdicts appear only because
a dispatched auditor profile wrote them through its own knowfleet session, with
its own provenance.

**It is never green without evidence.** An unreadable ledger, an unparseable
batch manifest, a created run that does not read back, a target count that
disagrees with the plan, a completion that does not take effect, or a dispatched
agent that fails — each is a crash, not a pass. A dry run never writes the
heartbeat, and an injected ledger may touch neither the production heartbeat nor
the production alert topic (ported from #400/#412).

## Pacing

Sol pacing is enforced in the planner, not in a comment: at most **2
reconciliation batches per UTC day** (`maxBatchesPerDay`), plus the daily
candidate audit. The daily run takes priority when it is due. An unopened batch
whose records all acquired verdicts by some other route is skipped rather than
parked on.

Note that the daily run and the reconciliation select _different_ sets: the
daily audits what is new since the watermark (`created_at > watermark`, cron
6baadbef2952's rule), while #450 closes the historical gap (candidates carrying
no verdict at all). Conflating them would make the daily run re-audit the
backlog.

## Reads and writes

Reads are read-only SQLite against the ledger, the same way the knowfleet poll
probes do it. Writes go through the **knowfleet MCP server**, never through SQL
— the invariants that make the ledger trustworthy live in that server:
`audit_run_create` snapshots each target's version hash, `audit_verdict_add`
refuses a completed run, `investigation_start` refuses a verdict that is not
machine-revisable, and completion is idempotent. Direct SQLite mutation is also
forbidden outright by the audit-loop contract.

One wrinkle worth knowing: the ledger is in WAL mode, and a read-only open of a
WAL database needs its `-shm` sidecar, which only exists while some process
holds the database open. In production `knowfleet-http` always does. A freshly
restored copy does not, so a strictly read-only open fails with
`SQLITE_CANTOPEN`; the reader falls back to a normal open for that case only,
and still issues nothing but `SELECT`s.

## Methods

| Method   | What it does                                                          |
| -------- | --------------------------------------------------------------------- |
| `pass`   | Survey → plan → open/adopt → ensure worked → complete → investigate   |
| `notify` | Escalate a failed, stalled, or needs-human pass to ntfy (else silent) |

Key `pass` arguments: `dispatch` (default **false** — orchestrate only), `open`,
`allowDaily`, `allowBatch`, `investigate`, `maxInvestigations`, `dryRun`,
`failOnError`.

## Running it

```bash
swamp workflow validate audit-ledger
swamp workflow run audit-ledger                          # scheduled defaults
swamp workflow run audit-ledger --input dryRun:json=true # decide, write nothing
swamp data get audit-ledger lastPass --json
```

Scheduled daily at 14:10 local by `com.guru.audit-ledger` (ten minutes after the
librarian's daily run creator), **not** by a `trigger.schedule`: this repo's
`swamp serve` runs with `--no-schedule`, so a cron trigger would silently never
fire (decision 38108534).

## Tests

```bash
~/.swamp/deno/deno test --allow-all packages/audit-ledger/audit_ledger_test.ts
~/.swamp/deno/deno test --allow-all workflows/workflow-audit-ledger_test.ts
```

The unit suite covers the decision core — adoption, pacing, batch skipping,
stall detection, cron ownership (including that an unreadable jobs file fails
_closed_), and the production-surface guards. The workflow suite pins the
scheduled shape through the real `swamp workflow evaluate`.

# a2a-conformance

Daily **A2A v1.0 conformance gate** for the fleet's A2A peers on kimchi
(Knowfleet task #426). It wraps the suite from Knowfleet task #353 —
`~/Code/active/a2a-edge/scripts/conformance.mjs` — which drives the A2A
project's own client (`a2a-cli`, pinned build) against every peer. A pass means
"a spec-reference client can use this peer".

| Target                                              | Kind            | Port               |
| --------------------------------------------------- | --------------- | ------------------ |
| `codex-kimchi`, `claude-kimchi`, `codebuddy-kimchi` | edge (a2a-edge) | 9931 / 9932 / 9933 |
| `pi-kimchi`, `librarian-kimchi`                     | reference peer  | 9910 / 9900        |

The suite owns every probe. This package owns scheduling, history, and
escalation.

## Run it

```sh
swamp workflow run a2a-conformance                           # what the schedule runs: strict, all targets
swamp workflow run a2a-conformance --input only=codex,claude # spot check a subset
swamp workflow run a2a-conformance --input strict:json=false # gate on the edges only
swamp workflow run a2a-conformance --input alertUrl=         # no alerting
```

Inputs: `only` (comma-separated target prefixes), `strict` (default **true**:
reference-peer failures also fail the gate), `skipSlow` (skip the cancel probe),
`alertUrl` (ntfy topic, default `/alerts`; empty disables).

## Results

```sh
swamp data get a2a-conformance lastRun --json      # newest verdict
swamp data versions a2a-conformance lastRun        # history (90 versions kept)
swamp data get a2a-conformance suite-log           # raw suite stdout/stderr
swamp data get a2a-conformance lastAlert --json    # last escalation attempt
```

The `@usefulish/a2a-conformance-summary` report renders each run as a table per
target, plus every failed or inconclusive probe. It also runs when the gate
fails.

## What counts as a failure

- **Any failed probe** on a gated target. Under `strict`, every target is gated.
  Otherwise only edges are.
- **Inconclusive** probes never fail the gate and never count as passes. For
  example, `task.cancel` when the peer finished before the cancel landed.
- **A run with no evidence is never green.** A missing report, a timeout (45
  min), zero targets, or an exit code that disagrees with the report all fail
  the run as a crash.

## Schedule, alerting, liveness

- **Schedule**: the launchd job `com.guru.a2a-conformance` runs at 06:30 daily
  (`deploy/launchd/`). It does _not_ use a workflow `trigger.schedule`, because
  this repo's `swamp serve` runs with `--no-schedule`. Install it:
  `cp deploy/launchd/com.guru.a2a-conformance.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.guru.a2a-conformance.plist`.
  Log: `~/Library/Logs/a2a-conformance.log`.
- **Alerting**: the `escalate` job runs only when `audit` fails. It POSTs the
  failing targets and the first failed probe to ntfy at priority 4. Delivery is
  checked: if ntfy is down, the step fails with `ALERT DELIVERY FAILED` and
  records it in `lastAlert`. A passing run sends nothing.
- **Liveness**: every full run writes
  `~/Scripts/network-status/machines/kimchi/heartbeats/a2a-conformance.heartbeat`
  and Knowfleet's layer-1 heartbeat checker watches it. That is how a job that
  stopped running gets noticed. Subset (`only`) runs never write it, so a spot
  check cannot vouch for the schedule.

## Testing the failure path safely

Don't test by pointing the production model at a broken suite. Create a scratch
model with `suitePath` set to a stub. Any `suitePath` other than the real suite
marks the run as **injected**, and an injected run cannot touch production: the
model refuses the production `/alerts` topic and the production heartbeat
directory. This ports Knowfleet #400 / #412, where hand- rolled test runs sent a
fabricated production alarm and could have faked a heartbeat.

```sh
swamp model create @usefulish/a2a-conformance a2a-conformance-smoke --global-arg suitePath=/path/to/stub.mjs
swamp model method run a2a-conformance-smoke run
swamp model method run a2a-conformance-smoke notify --input url=http://127.0.0.1:18731/test
swamp model delete a2a-conformance-smoke --force --yes
```

Pure logic is unit-tested in `a2a_conformance_test.ts`. The workflow's evaluated
form is tested in `workflows/workflow-a2a-conformance_test.ts`.

## Secrets

None pass through swamp. The suite reads the fleet token from the Keychain item
`a2a-edge.fleet-token` and hands it to `a2a-cli` through its environment, never
on a command line.

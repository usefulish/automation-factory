# nixos-adopt

Swamp workflow that **adopts an already-running NixOS machine into the usefulish
fleet** by converging it onto the `nix-config` flake with `nixos-rebuild`.

This is the **day-2 adoption** path — not the from-USB installer. The target
already boots NixOS and the operator already has SSH/sudo (root) access. The
workflow:

- **never** partitions, formats, installs from media, or generates
  `hardware-configuration.nix` (that is `scripts/provision-nixos.sh` in
  nix-config, a different tool);
- **never** touches credentials or enrolls Tailscale (deliberately manual, no
  auth keys in the repo/store);
- ships the fleet repo by tarball and runs the **established** `nixos-rebuild`
  mechanism (docs/FLEET-PROVISIONING.md "Day-2" + the "Bao specifically"
  adoption) against `hosts/<host>/` + `modules/nixos-common.nix`. It adds no
  configuration of its own — the flake is the source of truth. Role-specific
  config is applied **after**, separately. The workflow yields a _baseline_
  fleet member.

## Phases (fail before any destructive change)

| Job step                       | What it does                                                                                    | Safe to rerun   |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | --------------- |
| `prepare`                      | Local: record flake rev + tree cleanliness, stage the repo tarball                              | yes             |
| `ship-copy` / `ship-extract`   | Copy + unpack the repo to `remoteDir` on the target                                             | yes             |
| `discover`                     | Read-only: identity, arch, running generation, flakes, wired-into-flake + real hardware config  | yes (read-only) |
| `assert-ready`                 | **Gate**: stop before any change if the host is not adoptable                                   | —               |
| `plan`                         | `nix build` the target closure — **no activation** — reports drift                              | yes (read-only) |
| `assert-build`                 | **Gate**: stop before apply if the closure did not build                                        | —               |
| `approve`                      | Manual approval (apply mode only; skipped in inspect)                                           | —               |
| `apply`                        | `nixos-rebuild switch`/`test`. Idempotent (no-op if already converged); dry run in inspect mode | yes             |
| `reboot-trigger` / `reconnect` | Optional deferred reboot + operator-side reconnect poll                                         | yes             |
| `accept`                       | Read-only: verify the fleet baseline invariants                                                 | yes (read-only) |
| `assert-accept`                | **Gate**: fail the run if the baseline is unmet (apply mode only)                               | —               |
| `receipt`                      | Always runs: assemble the structured JSON + Markdown receipt                                    | yes             |

Remote access is preserved across the switch: a baseline switch does not stop
`sshd` (declaratively enabled) or tear down the network. When a reboot is needed
(kernel/bootloader change), it is scheduled _deferred_ so the exec returns
before the link drops, and reconnect is polled from the operator side — the
temporary disconnect is handled explicitly.

## Mechanism split

- **`nix-config/scripts/adopt-nixos.sh`** — the phased, idempotent host-side
  driver over `nixos-rebuild` (peer of `provision-nixos.sh`). Emits one JSON
  object per phase. Ships with the repo tarball; testable standalone
  (`scripts/adopt-nixos.test.sh`, mock toolchain).
- **`workflow-nixos-adopt.yaml`** — orchestration only: phase gating, approval,
  reboot/reconnect, and the receipt. Uses `@swamp/ssh` for the remote mechanics
  (Tailscale SSH as root by default).
- **`receipt.ts`** — pure, fixture-tested assembler that merges the four phase
  JSONs + operator-side facts (flake rev, dirty tree, reboot result) into the
  audit receipt.

## Usage

```bash
# Safe default: inspect only — discover + build + read-only accept, no changes.
swamp workflow run nixos-adopt --input host=bao

# Adopt for real (gated on manual approval):
swamp workflow run nixos-adopt --input host=bao --input mode=apply

# Activate without touching the bootloader first (prove activation):
swamp workflow run nixos-adopt --input host=bao --input mode=apply --input applyMode=test

# Apply and reboot, waiting for the host to return before acceptance:
swamp workflow run nixos-adopt --input host=bao --input mode=apply --input 'reboot:json=true'

# OpenSSH/key transport instead of Tailscale-as-root:
swamp workflow run nixos-adopt --input host=bao \
  --input 'transport:json={"kind":"ssh","user":"guru","identityFile":"~/.ssh/id_ed25519"}' \
  --input address=192.168.1.50
```

Receipts land in `receiptsDir` (default
`.swamp/nixos-adopt/receipts/<host>.{json,md}`).

## Inputs

| Input            | Default                         | Notes                                                  |
| ---------------- | ------------------------------- | ------------------------------------------------------ |
| `host`           | (required)                      | flake attribute + hostname; `hosts/<host>/` must exist |
| `address`        | `""`                            | empty derives `<host>.<tailnet>`                       |
| `tailnet`        | `oryx-herring.ts.net`           | MagicDNS suffix                                        |
| `transport`      | `{kind: tailscale, user: root}` | `@swamp/ssh` transport                                 |
| `repoPath`       | `/Users/guru/Code/nix-config`   | local flake checkout to ship                           |
| `remoteDir`      | `/tmp/nix-config`               | unpack location on the target                          |
| `mode`           | `inspect`                       | `inspect` (safe) or `apply`                            |
| `applyMode`      | `switch`                        | `switch` or `test` (apply mode)                        |
| `reboot`         | `false`                         | reboot + reconnect after apply                         |
| `reconnectTries` | `60`                            | reconnect poll attempts, 5s apart                      |
| `receiptsDir`    | `.swamp/nixos-adopt/receipts`   | receipt output dir                                     |

## Tests

```bash
# receipt assembler (fixtures) + workflow CEL/DAG (swamp evaluate)
deno test --allow-read --allow-write --allow-env --allow-run \
  packages/nixos-adopt/ workflows/workflow-nixos-adopt_test.ts

# host-side driver, incl. idempotency, against a mock toolchain (in nix-config)
bash ~/Code/nix-config/scripts/adopt-nixos.test.sh
```

## Requirements

- `@swamp/ssh` extension (`swamp extension pull @swamp/ssh`).
- `deno` on the operator machine (receipt assembly).
- On the target: `nix`, `nixos-rebuild`, `systemctl`, and the fleet repo present
  at `remoteDir` (shipped by the workflow).

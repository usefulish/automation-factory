# Deploying automation-factory (swamp serve + ChatGPT gateway) on kimchi

This directory holds the **real** deployment artifacts for running the
`packages/swamp-chatgpt-gateway` setup persistently on the development machine
(kimchi) and exposing it to a ChatGPT GPT Action.

The canonical operational reference (architecture, trust boundary, token/grant
lifecycle, troubleshooting) lives in the Knowfleet reference card
**`automation-factory-chatgpt-gateway`** — read that for *why* things are
wired this way. This file is the copy-paste runbook; the card is the source of
truth.

## What runs

| Component | Launched by | Bind | Notes |
| --- | --- | --- | --- |
| `swamp serve` (token auth) | LaunchAgent `com.guru.automation-factory-swamp-serve` | 127.0.0.1:9090 | `--admins user:admin`, reads tokens/grants from the repo's `.swamp/` |
| `swamp-chatgpt-gateway` (Deno) | LaunchAgent `com.guru.automation-factory-chatgpt-gateway` | 127.0.0.1:8787 | dumb REST↔WS adapter, no authz of its own |
| Tailscale Funnel | `tailscale funnel --bg 8787` | public `https://kimchi.oryx-herring.ts.net` | terminates TLS, forwards to :8787 |

Startup order matters: **swamp serve → gateway → funnel**. The gateway fails
open-but-useless if serve is down (healthz still reports ok); funnel is just a
reverse proxy so it can start any time.

## 1. Load the LaunchAgents (persistent, survives reboots)

> macOS Tahoe: `launchctl bootstrap` must run from an **unsandboxed Terminal**,
> not from a sandboxed agent shell (it is blocked there — see Knowfleet card,
> incident `122b840e`). Run these in a normal Terminal.app window:

```bash
launchctl bootstrap gui/$(id -u) \
  /Users/guru/Code/labs/automation-factory/deploy/launchd/com.guru.automation-factory-swamp-serve.plist
launchctl bootstrap gui/$(id -u) \
  /Users/guru/Code/labs/automation-factory/deploy/launchd/com.guru.automation-factory-chatgpt-gateway.plist
```

Both have `RunAtLoad` + `KeepAlive`, so they start now and on every login.

## 2. Expose the gateway via Tailscale Funnel

> **One-time tailnet enable.** Funnel is a tailnet-level capability. The first
> time you run the command below it prints an approval URL
> (`https://login.tailscale.com/f/funnel?node=…`); open it and approve, then
> re-run the command. After that, Funnel stays enabled for the tailnet.

```bash
/opt/homebrew/bin/tailscale funnel --bg 8787
```

Verify: `tailscale funnel status` should show `https://kimchi.oryx-herring.ts.net`
→ `http://127.0.0.1:8787`. Funnel is the only public exposure path — there is
**no** nginx/cloudflared/ngrok here, and the knowfleet ChatGPT *MCP* tunnel
(`knowfleet-chatgpt-tunnel.md`) is a separate, Connector-only path that does
**not** apply to this REST GPT Action.

## 3. (Re)create the restricted ChatGPT credential + grant

Tokens and grants live in the repo's `.swamp/` directory, which is gitignored
— they are **never committed**. Recreate after a fresh clone or rotation:

```bash
REPO=/Users/guru/Code/labs/automation-factory
# management token (admin; for reloads / minting)
swamp access token mint admin --principal user:admin --repo-dir "$REPO" --duration 365d
swamp access token reveal admin --yes --repo-dir "$REPO"   # store in ~/.config/automation-factory/admin-token.txt
# the token the GPT Action presents
swamp access token mint chatgpt --principal user:chatgpt --repo-dir "$REPO" --duration 365d
swamp access token reveal chatgpt --yes --repo-dir "$REPO"  # paste into the GPT Action's bearer auth
# narrow grant: chatgpt may only read+run promo-model-checker
swamp access grant create --subject user:chatgpt --allow read,run --on 'workflow:promo-model-checker' --repo-dir "$REPO"
```

If you add a grant while `swamp serve` is already running, reload the policy
snapshot:

```bash
swamp access reload --server ws://127.0.0.1:9090 --token "$(cat ~/.config/automation-factory/admin-token.txt)"
```

Or simply restart the serve LaunchAgent (grants are loaded at startup).

## 4. Health checks

```bash
# gateway up (local)
curl -fsS http://127.0.0.1:8787/healthz
# gateway up (public, via funnel)
curl -fsS https://kimchi.oryx-herring.ts.net/healthz
# enumerate approved workflows with the chatgpt token
curl -fsS -H "Authorization: Bearer $(cat ~/.config/automation-factory/chatgpt-token.txt)" \
  https://kimchi.oryx-herring.ts.net/v1/workflows
# openapi for the GPT Action
curl -fsS https://kimchi.oryx-herring.ts.net/openapi.json
```

## Logs

- `~/Library/Logs/automation-factory-swamp-serve.log`
- `~/Library/Logs/automation-factory-chatgpt-gateway.log`

## Stop / start / restart

```bash
launchctl kickstart -k gui/$(id -u)/com.guru.automation-factory-swamp-serve        # restart
launchctl kickstart -k gui/$(id -u)/com.guru.automation-factory-chatgpt-gateway    # restart
launchctl bootout  gui/$(id -u)/com.guru.automation-factory-swamp-serve             # stop (unload)
launchctl bootout  gui/$(id -u)/com.guru.automation-factory-chatgpt-gateway
```

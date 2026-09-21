# swamp-chatgpt-gateway

A thin REST/OpenAPI adapter that lets a ChatGPT **GPT Action** enumerate and run
access-approved [Swamp](https://swamp-club.com) workflows, without the GPT
Action having to speak Swamp's native WebSocket protocol.

```
ChatGPT GPT Action  ──HTTPS/REST+Bearer──▶  swamp-chatgpt-gateway  ──WebSocket (?token=<swamp-token>)──▶  swamp serve
```

## Why this exists

Swamp's `serve` command is a **WebSocket** API, not REST. ChatGPT GPT Actions
consume **OpenAPI 3.0** over HTTPS. This gateway translates between the two:

- `GET  /v1/workflows`          → `workflow.search`  (server-scoped to approved)
- `POST /v1/workflows/{name}/runs` → `workflow.run`  (synchronous, returns events)
- `GET  /v1/runs/{id}`          → `workflow.run.search` (fetch a past run)

## Authentication model

The gateway holds **no credentials of its own**. The bearer token a GPT Action
sends *is* a Swamp server token (`<name>.<secret>`). The gateway forwards it to
`swamp serve` via the `?token=<swamp-token>` WebSocket query parameter (the
`bearer.<token>` subprotocol is intentionally avoided — Swamp secrets can
contain characters outside the RFC 6455 subprotocol range, which some WebSocket
clients reject). Swamp's grant model then scopes what the caller may `read`/`run`,
so:

- "List my approved workflows" is free — `workflow.search` is filtered
  server-side by the token's principal grants.
- A restricted token simply never sees (and cannot run) workflows outside its
  grants.

Issue the token and its grant out-of-band (tokens and grants live in the
repo's `.swamp/` directory, which is gitignored — they are **never committed**):

```bash
REPO=/Users/guru/Code/labs/automation-factory

# 1. a server token for the ChatGPT user (store the revealed value securely)
swamp access token mint chatgpt --principal user:chatgpt --repo-dir "$REPO" --duration 365d
swamp access token reveal chatgpt --yes --repo-dir "$REPO"   # -> <name>.<secret>

# 2. scope it: allow read + run on the approved workflow(s) ONLY.
#    Everything else is denied by default (Swamp fail-closed on missing grant).
swamp access grant create --subject user:chatgpt --allow read,run \
  --on 'workflow:promo-model-checker' --repo-dir "$REPO"
```

Use a dedicated, non-admin principal (e.g. `user:chatgpt`) — do **not** make the
GPT Action principal an `--admins` entry, or it bypasses all grants.

## Run it

```bash
cd packages/swamp-chatgpt-gateway
SWAMP_SERVE_URL=ws://127.0.0.1:9090 PORT=8787 deno task serve
```

Environment:

| Var | Default | Purpose |
|-----|---------|---------|
| `SWAMP_SERVE_URL` | `ws://127.0.0.1:9090` | WebSocket endpoint of `swamp serve` |
| `PORT` | `8787` | Port the gateway listens on |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream call timeout |

## Wire protocol notes (for maintainers)

Swamp streams `{type:"event", id, event}` frames for `workflow.run`, then a
terminal `{type:"done", id}` (or `{type:"error", id}`). Non-streaming calls
(`workflow.search`, `workflow.run.search`) return a single response payload
frame (`{type:"workflow.search", id, payload:{data}}`) followed by `done`. The
gateway collects both shapes and assembles them into JSON. The canonical run id
is taken from the last streamed event that carries a `runId`.

## Deploying behind ChatGPT

GPT Actions reach the gateway over the public internet. On kimchi the gateway is
exposed via **Tailscale Funnel** (`https://kimchi.oryx-herring.ts.net` →
`127.0.0.1:8787`), and both the gateway and `swamp serve` run as launchd
LaunchAgents. The full, copy-paste runbook (load plists, enable Funnel, recreate
tokens/grants, health checks, logs, restart) is in
[`../../deploy/README.md`](../../deploy/README.md). The canonical operational
reference (architecture, trust boundary, token/grant lifecycle, troubleshooting)
is the Knowfleet card **`automation-factory-chatgpt-gateway`**.

Security posture: the bearer token is the only secret a caller needs, and it is
forwarded verbatim to Swamp — treat the gateway as an authenticating pass-through
proxy, not a public service. Swamp Grants are the single source of truth for what
a given token may read/run.

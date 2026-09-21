# automation-factory

A reusable [swamp](https://github.com/swamp-club/swamp) automation that takes a
GitHub repository and leaves behind a validated Mintlify documentation site,
ready to commit.

```sh
swamp workflow run @usefulish/mintlify-docs --input repo=owner/name
```

That one command checks the repository out into a disposable workspace, profiles
it, plans a page set, writes the pages with a locally installed coding agent,
generates `docs.json`, and refuses to finish if the result does not validate.

## What it produces

For `usefulish/mac-dependency-safety` — a shell-script repository with no
package manifest — a single run produced 15 pages across four navigation groups,
a schema-valid `docs.json`, and zero validation errors:

```
docs/
  docs.json
  Getting Started   index, quickstart
  Guides            9 pages, mostly one per top-level README section
  Reference         3 pages, one per executable script
  About             changelog
```

The exact page set varies with the repository, and with what the agent judges
worth adding beyond the plan — pages it adds are adopted into navigation rather
than left unreachable.

The checkout is left on a `docs/mintlify` branch with the changes uncommitted —
nothing is committed or pushed for you.

## Repository layout

This is a swamp monorepo: each automation lives in its own folder under
`packages/`, while swamp's registry files stay at the repo root.

| Path                         | What it is                                                        |
| ---------------------------- | ----------------------------------------------------------------- |
| `packages/mintlify/`         | The `@usefulish/mintlify` model type and its docs workflow.       |
| `packages/promo-model-checker/` | Daily audit of WorkBuddy's promotional model lineup.          |
| `workflows/`                 | Swamp workflow definitions (flat — swamp discovers them here).   |
| `extensions/models/`         | Upstream extension sources (`upstream_extensions.json`).         |

`modelsDir` is set to `packages` in `.swamp.yaml`, so swamp discovers each
`packages/<name>/` folder that contains a model definition. Workflows are kept
flat at the repo root because swamp's workflow discovery is non-recursive.

## How it is built

| Piece                                   | What it is                                           |
| --------------------------------------- | ---------------------------------------------------- |
| `workflows/workflow-mintlify-docs.yaml` | The workflow: three jobs, six steps.                 |
| `@usefulish/mintlify`                   | Model type — `inspect`, `plan`, `author`, `ensureConfig`, `validate`. |
| `@swamp/git` + `ensure_checkout`        | Official git model, extended with an idempotent checkout. |
| `@usefulish/mintlify-summary`              | Report rendering findings, cost, and navigation.     |

The extension lives in `packages/mintlify/` and has its own
[README](packages/mintlify/README.md) covering methods, global
arguments, the agent sandbox, and every validation rule.

The split is deliberate: **everything except the prose is deterministic**.
Inspection, planning, config reconciliation, and validation are ordinary code
with unit tests. Only page content is written by an agent, against a fixed brief
derived from the inspection, and it is gated by validation before the run can
succeed.

## Workflow inputs

| Input          | Default                                     | Description                                     |
| -------------- | ------------------------------------------- | ----------------------------------------------- |
| `repo`         | *(required)*                                | `owner/name`.                                   |
| `host`         | `github.com`                                | For GitHub Enterprise or another forge.         |
| `sourceUrl`    | derived from `host` and `repo`              | Optional clone URL or local repository path.    |
| `ref`          | default branch                              | Branch or tag to document.                      |
| `workspace`    | `.swamp/mintlify/workspaces`   | Root holding per-repository checkouts.          |
| `docsDir`      | `docs`                                      | Docs directory in the target repo.              |
| `docsBranch`   | `docs/mintlify`                             | Branch the generated docs land on.              |
| `theme`        | `mint`                                      | Mintlify theme.                                 |
| `siteName`     | repository name                             | Documentation site name.                        |
| `agentProvider`| `claude`                                    | Authoring provider: `claude` or `codex`.        |
| `agentCliPath` | provider executable                         | Optional path/name override for the provider CLI. |
| `agentModel`   | CLI default                                 | Model for the authoring agent.                  |
| `instructions` | none                                        | Extra authoring guidance.                       |
| `reset`        | `true`                                      | Reset the checkout to the remote ref before documenting. |
| `depth`        | `1`                                         | Clone depth; `0` for full history.              |
| `strict`       | `true`                                      | Orphan pages and missing descriptions are errors. |
| `overwrite`    | `false`                                     | Rewrite existing pages rather than preserving them. |

```sh
# Document a tag, with docs at the repository root and extra guidance
swamp workflow run @usefulish/mintlify-docs \
  --input repo=owner/name \
  --input ref=v2.1.0 \
  --input docsDir=. \
  --input instructions="Lead with the migration guide; assume a Kubernetes audience."

# Document an existing local checkout without modifying it
swamp workflow run @usefulish/mintlify-docs \
  --input repo=owner/name \
  --input sourceUrl=/absolute/path/to/repository

# Relax the gate so orphan pages and missing descriptions are warnings
swamp workflow run @usefulish/mintlify-docs --input repo=owner/name --input 'strict:json=false'

# Use Codex for the fuzzy authoring node; all other nodes are unchanged
swamp workflow run @usefulish/mintlify-docs \
  --input repo=owner/name \
  --input agentProvider=codex
```

## From a fresh clone

```sh
swamp extension install     # restores @swamp/git from extensions/models/upstream_extensions.json
swamp workflow run @usefulish/mintlify-docs --input repo=owner/name
```

The `@usefulish/mintlify` extension lives in this repository, so it is
discovered automatically — no `swamp extension source add` needed.

## Requirements

- `git` on `PATH`.
- A supported coding-agent CLI (Claude Code by default, or Codex) installed and
  signed in. No API key is required when the CLI already holds a session. Set
  the `agentProvider` workflow input to select it, and `agentCliPath` only when
  the executable needs an explicit override.
- Network access on the first run so the published Mintlify schema can be
  fetched; a vendored copy is the offline fallback.

## Re-running it

The workflow is idempotent. `ensure_checkout` clones the repository the first
time and resets an existing checkout to the remote ref on later runs, so each
run starts from pristine upstream and regenerates the docs.

Pass `--input 'reset:json=false'` to iterate on top of a previous run's output
instead. In that mode `overwrite` decides whether pages that already exist are
rewritten or left alone. Boolean inputs need the `:json=` form — a bare
`reset=false` is passed as the string `"false"` and is rejected.

Because the checkout is reset each run, **anything you hand-edit in the
workspace is discarded on the next run.** Commit or copy it out first.

## Running across many repositories

Every method takes the checkout as an argument and every data instance is
suffixed with a per-repository slug, so one model definition already serves any
number of repositories. To fan out across an account, add a `forEach` step over
a list of repositories rather than calling the workflow in a loop — see rule 6
in [CLAUDE.md](CLAUDE.md).

## Development

```sh
# Type-check, format, lint, and score the extension
~/.swamp/deno/deno check packages/mintlify/**/*.ts
swamp extension fmt packages/mintlify/manifest.yaml
swamp extension quality packages/mintlify/manifest.yaml --json

# Unit tests (no network, no agent invocation)
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env \
  packages/mintlify/mintlify_test.ts

# Workflow identifier canonicalization (runs `swamp workflow evaluate`)
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env \
  workflows/workflow-mintlify-docs_test.ts
```

Inspect a failed run through its report rather than guessing:

```sh
swamp report get @usefulish/mintlify-summary --model mintlify-docs --markdown
swamp report get @swamp/workflow-summary --workflow mintlify-docs --json
```

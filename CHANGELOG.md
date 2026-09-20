# Changelog

All notable changes to this repository are documented here.

## [Unreleased]

### Added

- **Provider-neutral documentation authoring** — the fuzzy `author` method now
  supports both Claude Code and Codex behind provider adapters. Claude keeps
  its existing restricted CLI flags; Codex uses non-interactive
  `codex exec --sandbox workspace-write --ephemeral --json` and its JSONL
  output is normalized into the same author-run resource. The workflow exposes
  `agentProvider` and `agentCliPath` per run while the deterministic inspect,
  plan, configuration, and validation nodes remain provider-independent.

- **Per-target checkout status models** — the final workflow status step now
  scopes its model name to `owner/repository`, preventing a prior target's
  persisted `repoPath` from being reused by a later run.

- **Local repository sources for `mintlify-docs`** — pass
  `--input sourceUrl=/absolute/path/to/repository` to clone from an existing
  local checkout into the disposable workspace. The existing `host` + `repo`
  HTTPS source remains the default.

- **`mintlify-docs` workflow** — generates a validated Mintlify documentation
  site for any GitHub repository from a single `--input repo=owner/name`. Three
  jobs: check the repository out into a disposable workspace, document it, then
  verify. Nothing is committed or pushed; the run leaves the workspace checkout
  on a `docs/mintlify` branch with the changes ready to commit.

- **`@usefulish/mintlify` model type** (`extensions/models/mintlify/`) with five
  methods:
  - `inspect` — deterministic repository profile: identity, languages, package
    manifests, executable entrypoints, markdown outline, CI, existing docs.
  - `plan` — derives the page set and a per-page authoring brief from the
    profile. Same profile in, same plan out.
  - `author` — writes the pages with a locally installed coding-agent CLI.
    Provider-specific invocation and output parsing stay behind an adapter,
    while the common prompt, results, and downstream nodes remain shared.
  - `ensureConfig` — creates or updates `docs.json`, regenerating navigation
    from the pages actually on disk and preserving operator customisations.
  - `validate` — the quality gate: Mintlify's published JSON Schema plus
    navigation resolution, reachability, frontmatter, substance, internal link,
    and asset checks. Root-relative links to the docs home (`/`) and to a
    directory index resolve the way Mintlify serves them.

- **`ensure_checkout` method on `@swamp/git`** — idempotent clone-or-update with
  working-branch creation via `checkout -B`, so the workflow can be re-run
  without clearing the workspace first. Refuses to reset a path holding a
  checkout of a different repository.

- **`@usefulish/mintlify-summary` report** — renders validation findings, authoring
  cost and duration, and the generated navigation. Attached to the model type by
  default, so it runs even when a method fails and a failing validation gate
  still shows its findings.

- Vendored copy of the Mintlify `docs.json` schema as an offline fallback, so
  validation degrades to a cached or bundled schema rather than silently
  skipping schema conformance.

### Notes

- The extension bundles `ajv@8.18.0` (8.17.x carries the CVE-2025-69873 ReDoS
  advisory). Per swamp's bundling model, extension npm dependencies are inlined
  at bundle time and are not tracked by `deno.lock`.
- `data.latest()` resolves at workflow-run start, not per step, so the workflow
  derives the checkout path from its inputs rather than from the checkout step's
  output.

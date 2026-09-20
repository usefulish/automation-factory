# Changelog

All notable changes to this repository are documented here.

## [Unreleased]

### Added

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
  - `author` — writes the pages with a locally installed coding-agent CLI,
    scoped to the checkout with `--restricted`, an explicit tool allowlist, and
    no permission-bypass flag.
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

- **`@usefulish/mintlify-docs` report** — renders validation findings, authoring
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

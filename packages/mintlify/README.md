# @usefulish/mintlify

Turn any repository checkout into a validated [Mintlify](https://mintlify.com)
documentation site.

The extension splits documentation generation into deterministic steps and one
agentic step. Inspection, planning, config reconciliation, and validation are
ordinary code — same repository in, same result out. Only the prose itself is
written by a coding agent, and it is written against a fixed brief derived from
the inspection, then gated by validation before anything is considered done.

Nothing in here is specific to a particular repository or language. Every
heuristic reads from the inspected profile, and the target checkout is a method
argument, so one model definition can serve many repositories.

## Install

```sh
swamp extension pull @usefulish/mintlify
```

Requires `git` and a supported coding-agent CLI (Claude Code by default, or
Codex) installed and signed in on the host. No API key is needed when the CLI is
already authenticated.

## Model type: `@usefulish/mintlify`

| Method         | What it does                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------- |
| `inspect`      | Profile a checkout — identity, languages, manifests, entrypoints, markdown outline, docs.    |
| `plan`         | Derive the page set and per-page authoring briefs from the profile.                          |
| `author`       | Write the pages with a locally installed coding agent, scoped to the checkout.               |
| `ensureConfig` | Create or update `docs.json`, regenerating navigation from the pages on disk.                |
| `validate`     | Check `docs.json` against Mintlify's published schema, plus links, frontmatter, and orphans. |

Every method takes `repoPath`, so the same definition can process any number of
repositories. Data instances are suffixed with a per-repository slug
(`profile-owner-name`, `validation-owner-name`, …) so results never collide.

```sh
swamp model create @usefulish/mintlify docs-factory

swamp model method run docs-factory inspect --input repoPath=/path/to/checkout
swamp model method run docs-factory plan --input repoPath=/path/to/checkout
swamp model method run docs-factory author --input repoPath=/path/to/checkout
swamp model method run docs-factory ensureConfig --input repoPath=/path/to/checkout
swamp model method run docs-factory validate --input repoPath=/path/to/checkout
```

## Global arguments

| Argument              | Default                          | Description                                               |
| --------------------- | -------------------------------- | --------------------------------------------------------- |
| `docsDir`             | `docs`                           | Docs directory in the target repo; `.` puts docs at root. |
| `theme`               | `mint`                           | Mintlify theme for newly created configs.                 |
| `primaryColor`        | `#0D9373`                        | Primary brand colour.                                     |
| `lightColor`          | `#07C983`                        | Primary colour in dark mode.                              |
| `darkColor`           | `#0D9373`                        | Primary colour in light mode.                             |
| `agentProvider`       | `claude`                         | Authoring provider: `claude` or `codex`.                  |
| `agentCliPath`        | provider executable              | Optional CLI path/name override.                          |
| `agentModel`          | CLI default                      | Model the authoring agent should use.                     |
| `agentTimeoutMs`      | `1800000`                        | Wall-clock timeout for one authoring run.                 |
| `schemaUrl`           | `https://mintlify.com/docs.json` | Published Mintlify config schema.                         |
| `schemaCacheTtlHours` | `24`                             | How long a fetched schema stays fresh.                    |

The `author` method also accepts per-run `provider` and `cliPath` arguments.
These take precedence over the global settings, which lets one workflow model
serve runs from different providers without persisting provider-specific state.

## Provider boundary and sandboxing

`author` owns the common prompt, file-change detection, result resource, and run
log. A provider adapter owns only the executable arguments and output parsing:

- **Claude** keeps the original restricted contract: `--restricted`, an explicit
  `Read Glob Grep Write Edit TodoWrite` allowlist, `--add-dir
  <checkout>`, and
  `--permission-prompts none`. Permission bypass is never used.
- **Codex** runs through
  `codex exec --sandbox workspace-write --ephemeral
  --json`. Its working
  directory is the disposable repository checkout, and the JSONL event stream is
  normalized into the same author-run resource used for Claude.

The prompt forbids writing `docs.json`, touching source outside the docs
directory, inventing behaviour, and emitting placeholder text. Validation then
enforces the last of those independently.

## Validation

`validate` is the quality gate, and it fails the method (and any workflow step)
when it finds errors unless `failOnError=false`.

- **Schema** — `docs.json` is validated against Mintlify's published JSON
  Schema. The live schema is fetched and cached; a vendored copy ships with the
  extension so validation still runs offline rather than silently degrading.
  Errors belonging to theme variants the config did not select are filtered out,
  so a single mistake is reported once rather than nine times.
- **Navigation resolves** — every page referenced in navigation exists on disk.
- **Reachability** — every page on disk is reachable from navigation.
- **Frontmatter** — every page has a `title`, and (in strict mode) a
  `description`.
- **Substance** — pages that are effectively empty, or still contain `TODO`,
  `TBD`, `FIXME`, or "coming soon", fail.
- **Links and assets** — internal links resolve to real pages, and referenced
  images and files exist.

With `strict` (the default), orphan pages and missing descriptions are errors;
otherwise they are warnings.

## Extension to `@swamp/git`: `ensure_checkout`

The package also adds an idempotent `ensure_checkout` method to `@swamp/git`.
`clone` fails when the destination exists, which makes a re-runnable workflow
awkward. `ensure_checkout` clones when the path is absent, fetches and resets an
existing checkout to the requested ref, and creates or moves the working branch
with `checkout -B` so re-running is a no-op instead of an error.

```sh
swamp model method run repo ensure_checkout \
  --input url=https://github.com/owner/name.git \
  --input path=.swamp/workspaces/owner/name \
  --input branch=docs/mintlify
```

It refuses to touch a path that holds a checkout of a different repository,
because `reset` discards local changes.

## Report: `@usefulish/mintlify-summary`

A method-scope report attached to the model type by default. It renders the
validation findings, the authoring run (cost, duration, files written), and the
generated navigation. Reports run even when a method fails, so a failed
validation gate still shows its findings:

```sh
swamp report get @usefulish/mintlify-summary --model docs-factory --markdown
```

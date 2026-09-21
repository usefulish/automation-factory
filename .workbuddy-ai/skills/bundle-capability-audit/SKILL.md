---
name: bundle-capability-audit
description: Answer "does this tool support X?" for a bundled CLI or desktop app with evidence instead of assumption, by scanning its JS bundle, docs tree, and plugin/connector marketplaces. Use when a capability claim about an installed harness matters (A2A, MCP, auth model, sandboxing, protocol support) and a wrong answer would be written into a decision record or fleet task.
description_en: Evidence-based capability audit of a bundled CLI or app
description_zh: "对打包 CLI/应用做有据可查的能力审计"
agent_created: true
---

# Bundle capability audit

Answering "does harness X support protocol Y?" by reasoning from general knowledge is how
wrong claims get written into decision records. This skill produces a grep-and-read receipt
instead.

## When to use

- A capability question about an installed CLI/desktop app (protocol support, auth model,
  sandbox mechanism, interop surface).
- Before writing a capability claim into a knowfleet record or fleet task.
- When a vendor's public docs are thin, or contradict what the bundle does.

## Method

### 1. Locate the artefacts

```sh
ls -la "/Applications/<App>.app/Contents/Resources/app.asar.unpacked/"
ls -la "<app>/Contents/Resources/app.asar.unpacked/cli/dist/"     # bundled JS
ls    "<app>/Contents/Resources/app.asar.unpacked/cli/dist/web-ui/docs/<lang>/"
ls    ~/.<tool>/plugins/marketplaces/                             # plugin catalogues
ls    ~/.<tool>/connectors-marketplace/connectors/                # connectors
```

Bundled docs are often the richest source and are frequently ahead of the public site.

**An Electron app has at least three separate code surfaces — audit all of them.** The unpacked tree,
the packed `app.asar` (the desktop/main process), and any bundled CLI (`cli/dist/*.js`). A feature can
be present in one and absent in another, and **a feature can split across them: transport present,
content absent.** WorkBuddy's expert mode is the worked example — the CLI carries `expertId` in
session meta, has `"expert"` in its mode enum, and ships the `interactionmode-expert` fragment with the
mode's tool policy, while *every* expert-package marker (`expertType`, the `my-experts` marketplace,
the persona collector, the authoring toolchain) is zero in the same bundle. Grepping one surface would
have produced a confidently wrong yes or no.

**Also check the installed plugin/marketplace cache**, not just the bundle. First-party capabilities
are frequently implemented as plugins the app composes at runtime, so the feature's *content* lives on
disk in `~/.<tool>/plugins/cache/<marketplace>/<plugin>/` while its *loader* lives in the bundle. Read
the loader's gates (`marketplaceName === …`, `name.startsWith(…)`) to see whether a user-authored
package can reach the same path — usually it cannot, and that gate is the actual answer.

**Enumerate the doc surface before reading any doc.** `web-ui/docs/sidebar-en.json` is the table of
contents; walk its `items`/`link` recursively and print it. That answers "is capability X documented
at all?" in one call and tells you which pages are worth opening. A capability with no page in the
sidebar is usually absent from the product, not merely undocumented. Do this *before* the bundle
scan — it scopes the grep, and it is cheaper than reading pages one by one.

**The packed `app.asar` holds logic the unpacked dir doesn't.** Electron apps ship two trees:
`app.asar.unpacked/` (only what the packaging config excluded) and `app.asar` (everything else — for
WorkBuddy that is `/main/` and `/renderer/`, i.e. prompt assembly, identity injection, config-dir
resolution). Auditing only the unpacked tree makes a capability look absent when the implementation
is merely packed. If a feature is user-visible but has no code in `unpacked/`, it is in the asar.

Do **not** read `app.asar` as one string — it is ~296MB and the read is SIGTERM'd (exit 137), the
same failure mode as recursive grep. Parse its index instead: asar is a header, a JSON directory,
then concatenated blobs.

```python
import struct, json
P = "/Applications/<App>.app/Contents/Resources/app.asar"
with open(P, "rb") as f:
    a, b, c, d = struct.unpack("<IIII", f.read(16))   # d = JSON index length
    idx = json.loads(f.read(d).decode("utf-8", errors="replace"))
base = 16 + d
if base % 4: base += 4 - (base % 4)                   # blobs are 4-byte aligned
def resolve(path):
    node = idx
    for part in path.strip("/").split("/"): node = node["files"][part]
    return node
def read(path):
    n = resolve(path)
    with open(P, "rb") as f:
        f.seek(base + int(n["offset"]))
        return f.read(int(n["size"])).decode("utf-8", errors="replace")
```

Walk `idx["files"]` recursively to enumerate every path without reading a byte of content — that
alone answers "is there a module for X?" — then `read()` only the few files that matter. This is how
you find an identity-injection template, a config-dir resolver, or a profile mechanism, none of
which appear in the unpacked tree.

### 2. Scan the bundle with Python, NOT recursive grep

**Trap 1 — recursive grep dies.** `grep -r` over plugin/marketplace trees gets SIGTERM'd
(exit 137) under the sandbox. Do not retry it; switch to a Python `os.walk` scanner.

**Trap 2 — regex backtracking dies.** A nested quantifier like
`[\w./~-]*credential[\w./-]*` backtracks catastrophically and also gets SIGTERM'd. Use
bounded quantifiers (`{0,60}`) or `findall` on a simple literal.

**Trap 3 — the brokered `grep` has no BRE alternation, and fails SILENTLY.** Under the WorkBuddy
sandbox `grep` is **toybox 0.8.13**, which does not implement `\|` in basic regex. So
`grep -q "a\|b"` reports NO MATCH — exit 1, no warning — and any presence check written that way
answers "absent" for something that is present. Use `grep -E "a|b"`; toybox does support ERE
alternation. This is the `#201` "blind to absence" class in its purest form, and it is the most
dangerous failure available to this method, because a grep that returns 0 is *supposed* to be the
evidence. **Always run a positive control before believing a zero:** re-run the same pattern
against a string you know is there. A zero with no control is not a finding.

Related: the same environment is not GNU userland. `ps` is sandbox-blocked (use `pgrep -fl`), and
`/tmp` is per-call isolated — a log written to `/tmp` in one call is gone in the next, so write
diagnostic output into the workspace if you need to read it back.

Scanner template that works:

```python
import re, os
p = "<bundle>/dist/main.js"
d = open(p, encoding="utf-8", errors="replace").read()
print("loaded", len(d))
for label, pat in [
    ("marker-a", r'\ba2a\b'),          # word-bounded!
    ("marker-b", r'agent-card'),
    ("context",  r'[A-Za-z0-9_./~-]{0,60}credentials\.json'),
]:
    rx = re.compile(pat)
    hits = rx.findall(d)
    uniq = list(dict.fromkeys(hits))
    print(f"-- {label}: {len(hits)} total, {len(uniq)} unique")
    for u in uniq[:14]:
        print("  ", u)
```

Then print context around matches (±120 chars, newlines stripped) and **dedupe by a context
slice**, or a minified bundle floods you with the same hit.

For directory walks, prune `node_modules`/`.git` and skip files over ~3MB.

### 3. Use definitive markers, not substrings

This is the step that decides whether the answer is trustworthy.

- **Always word-bound.** `a2a` matched 2,192 times in one bundle — every single hit was a hex
  colour literal (`a52a2a`, `8a2be2`), a base64 blob, or an obfuscated `_0x...` identifier.
  `\ba2a\b` matched 0. The substring count is worse than useless; it invites a false positive.
- **Prefer protocol-specific strings** that cannot occur incidentally: `agent-card`,
  `well-known/agent`, `X-A2A-Identity`, `message/send`, `agent2agent`.
- **Check what a hit actually is.** One `message/send` turned out to be the WeCom API URL.
  37 `security` hits were "stock/security identifier", SQL `SECURITY SELECT`, and a Seatbelt
  rule — not `security find-generic-password`.
- **Distinguish lookalike protocols.** `ACP` (Agent Client Protocol, editor↔agent) is not
  `A2A` (agent↔agent). A bundle can have hundreds of one and zero of the other.

### 4. Check docs, marketplaces, connectors

```sh
# docs tree — a single grep answers the "is it documented?" half
grep -ril "<marker>" "<app>/.../web-ui/docs/"
# plugin catalogues: list, then inspect the plausibly-relevant ones
ls ~/.<tool>/plugins/marketplaces/*/plugins/
```

Marketplace hits are usually noise (lockfile hashes, obfuscated name tables). Enumerate the
plugin *names* first — that tells you whether a capability is packaged without reading any code.

### 5. For a plugin/extension format, read the validator, not the spec

When the question is "can I author my own X?" (expert, plugin, connector, skill), the prose spec
describes *intent* and the validator script *enforces*. They are different documents, and the
difference is where every surprise lives. Find the validator (`validate_*.py`, `*_schema.json`, a
`lint` subcommand) and read it end to end before trusting a spec page.

What only the validator revealed in the WorkBuddy expert case:

- **Hard errors and warnings are separated in code, not in prose.** "Exactly 3 tags" was an error;
  "description 40–50 chars" was a warning; a missing README was a warning. The spec presented all
  three as one flat list of requirements.
- **Negative constraints.** `hooks/` and `commands/` are *forbidden directories* — capability the
  format deliberately refuses. A spec that lists only what is supported never says this. **Audit for
  what the format bans, not just what it allows.**
- **A placement rule that was the whole ballgame.** Validation failed unless the package sat under
  one specific config dir. Nothing in the prose said the location was load-bearing.
- **A capability ceiling.** An agent definition whose frontmatter declared `tools:` was a hard
  error — so the persona layer *cannot* grant capability, and real capability had to arrive via a
  separately validated `skills/` array. That one line inverted the answer to "is a custom expert
  useful?".

**Then check the validator's path handling.** If it calls `Path(x).resolve()` and *then* tests
containment against a base directory, **symlinks are rejected** — the resolved path has left the
allowed tree. That kills the common "keep the real files in a repo, symlink them in" workflow, which
is precisely the pattern that *does* work elsewhere in the same product. The validator refusing it is
a real finding; whether the runtime loader is equally strict is a separate, unverified question — do
not collapse the two.

**And check the validator's own fallbacks.** A hardcoded default (`~/.workbuddy`) that differs from
the machine's actual config dir turns a correctly-placed package into a confusing failure that points
at a path which genuinely *is* a product directory. Note which env var must be exported for the tool
to agree with the app.

### 6. Cross-check the public docs

Local artefacts prove what shipped; public docs prove what is supported. Fetch the vendor's
docs for the specific question. Note when the two disagree — that disagreement is itself a
finding worth recording.

## Reporting the result

- **Record the verification level honestly.** Static inspection = `static`, not `runtime`.
  "I read the bundle and the docs" is a different claim from "I ran it".
- **State the boundary explicitly.** Grep-based absence is strong evidence but not proof: a
  dynamically-required or remotely-fetched module would not be visible. Say so.
- **Separate "absent" from "present but different".** The useful answer to "does it do A2A?" is
  usually "no — but it does have MCP, ACP, and a first-party HTTP API, and here is the one that
  looks closest".
- **Flag doc-vs-implementation contradictions** rather than silently picking a side. Leave it
  unresolved and say which reading the code supports.

## Output contract

An audit produces three different things. They go to three different places — do not collapse them
into one, and do not put the method where a fact belongs.

| Output | Example | Where it goes |
|---|---|---|
| **Method** — how to audit | this file | a skill (here). A manual, not a store entry. |
| **Finding** — what is true of a harness | "CodeBuddy has no A2A" | the per-harness **capability card** in knowfleet reference (`codebuddy.md`, `cc-onboarding.md`, …), **fingerprint-stamped** |
| **Receipt** — what was measured, against which build | `\ba2a\b`=0 in bundle sha256 `…` | the **audit ledger**, not a knowledge record |

**Stamp the fingerprint.** Every capability claim is about a moving target: the app auto-updates and
the claim silently expires. Record what build the claim was verified against — bundle path + sha256,
or the app version string — so a drift check can tell you the moment it goes stale. A claim without
a fingerprint is a liability, not a fact.

**Never file an audit verdict as a knowledge record.** Audit receipts are operational provenance;
putting them in knowledge creates a circular engine (decision `17feb113`). A finding that belongs in
knowledge goes there as a normal claim, citing the card.

### Where these live (kimchi)

| Output | Concrete home |
|---|---|
| Method | this skill (`~/.workbuddy-ai/skills/bundle-capability-audit/`) |
| Finding | a card in knowfleet reference — `codebuddy.md` is the worked example; write it with `reference_write`, never a file |
| Receipt | `~/Code/active/knowfleet/fleet/bundle-fingerprints.json` (git-versioned; the *only* place full hashes live) |

After a new audit, update the registry entry and the card in the same pass — the registry is what
makes the card's claims expire-able:

```sh
cd ~/Code/active/knowfleet
node scripts/bundle-capability-drift.js fingerprint <harness>   # new hashes
node scripts/bundle-capability-drift.js check                   # must exit 0 when done
```

**Writing the card — two gotchas.** `reference_section_update` takes exactly ONE section: the content
must contain the target heading and **no other heading at any level**. A `###` sub-heading inside the
body is rejected with `INVALID_SECTION`, so flatten sub-points into bold labels. And `record_refs` in
`bundle-fingerprints.json` uses **8-char id prefixes** (`"c9745925"`), while `knowledge_record` returns
a full UUID — truncate before writing. Validate the JSON (`node -e "JSON.parse(...)"`) before running
`check`; a trailing comma fails the whole check.

A non-zero `check` is not a failure of your work — it means the build moved since the recorded
audit, i.e. the card is stale and needs redoing. `scripts/knowfleet-reality-watch.sh` runs `check`
daily and alerts on drift; it never rewrites the registry, so updating a fingerprint is always a
deliberate act of re-auditing.

## Pitfalls

- Treating a substring count as a match count.
- **Reading a format spec instead of its validator.** Specs describe intent; the validator enforces.
  The hard errors, the forbidden directories, and the placement rules are usually only in the code.
- **Auditing one code surface and calling it the answer.** Desktop asar and bundled CLI diverge; a
  capability can be half-present. Grep both before saying yes or no.
- **Trusting a zero-hit grep without a positive control.** The sandbox `grep` is toybox, not GNU —
  a pattern it cannot parse returns 0 hits rather than an error. Prove the pattern can match
  something before you treat silence as absence.
- Assuming a vendor doc describes the shipped build (docs are often inherited boilerplate —
  check whether the product is a derivative of another).
- Reporting a capability gap without reporting what *does* exist, which leaves the reader
  unable to act.
- Claiming a runtime property (auth flow, bind behaviour) from static reading.

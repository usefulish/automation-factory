---
name: node-test-child-env
description: Make a Node test suite hermetic against an environment the host injects into spawned children (a NODE_OPTIONS shim, a proxy, a config dir) — scrub the child env, keep process cleanup in a finally the ready-wait cannot escape, and hold the invariant with a positive-controlled structural guard. Use when a test spawns node children and a child "never becomes ready", emits unparseable output, or the whole suite hangs instead of failing.
description_en: Harden Node tests against a host-injected child environment
description_zh: "让 Node 测试对宿主注入的子进程环境免疫"
agent_created: true
---

# Node test child-env hermeticity

## When to use

- A suite **hangs** — no output, no failure, just time passing.
- A spawned child "never becomes ready"; the ready-wait times out with **empty stderr**.
- A `-e` / snippet child emits output the test cannot parse.
- A test passes alone but hangs or fails under the full runner or an IDE.
- **Before writing any new test that spawns `process.execPath`.**

## The hazard in one line

`spawn`/`execFileSync` inherit the parent environment by default. If the host injects
`NODE_OPTIONS=--require=<shim>` (an IDE, a sandbox, a coverage hook), that shim loads into **every**
node child a test spawns, and the child misbehaves in ways that read as product bugs.

## Diagnose in 60 seconds

1. `echo "$NODE_OPTIONS"` — is anything injected?
2. Re-run the single suspect file with it stripped:
   `env -u NODE_OPTIONS node --test test/thefile.test.js`
   Passes without it, hangs with it → you have an unguarded spawn.
3. Locate every site:
   `grep -rnE "(spawn|spawnSync|execFileSync|execSync)\(\s*(process\.execPath|NODE)" test/`

## Fix

### 1. One helper, not a per-file copy

`test/helpers/child-env.js`:

```js
export function childEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  return env;
}
```

Order matters. A file that writes `{ ...process.env, MY_VAR: x }` **still inherits the shim** —
spreading `process.env` first is the most common near-miss. Replace the *base* of the spread:
`{ ...childEnv(), MY_VAR: x }`.

### 2. Pass it at every node-spawning site

`env: childEnv()`. Not needed for `bash`/`git`/`sqlite3` children — they cannot load
`NODE_OPTIONS` — but check the shell script does not invoke `node` internally.

### 3. Move every ready-wait INSIDE the `try`

This is a second, independent bug, and the one that turns a failure into a hang:

```js
const child = spawn(process.execPath, args, { env: childEnv() });
try {
  await waitForReady(child);   // MUST be inside the try
  // ...
} finally {
  child.kill('SIGTERM');
}
```

A wait placed **above** the `try` rejects out of the test before `finally` runs, orphaning the
child. The orphan holds the test file's event loop open and `node --test` never finishes that
**file** — so the suite hangs with no output at all. Same rule for any early `await`/`assert` that
can throw.

### 4. Never `--test-timeout=0`

Keep a finite timeout so a future hang fails instead of burning hours. `0` removes the last line of
defence against exactly this class of stall.

### 5. Hold the invariant structurally

A fix that depends on remembering is not a fix. Add a guard test that scans the tree:

```js
const SPAWN_CALL = /(?:^|[^\w.])(spawn|spawnSync|execFileSync|execSync)\(\s*(?:process\.execPath|NODE)\b/g;
const FLOOR = 10;   // sites observed when written — see the positive control

test('the scanner actually finds node-spawning sites (positive control)', () => {
  assert.ok(findSpawnSites().length >= FLOOR,
    'scanner is broken, so a clean result below would be meaningless');
});

test('every node child is spawned with an env that cannot leak NODE_OPTIONS', () => {
  const offenders = findSpawnSites().filter((s) => !s.src.includes('childEnv()'));
  assert.deepEqual(offenders.map((s) => `${s.file}:${s.line}`), []);
});
```

Two non-obvious requirements:

- **Slice each call with a string- and comment-aware paren matcher.** Several sites pass an `-e`
  snippet as a quoted argument, and those snippets contain parentheses of their own. A naive
  counter closes the call early and reports a *guarded* site as unguarded.
- **Carry a positive control.** A scanner that matches nothing passes vacuously — the very
  blind-to-absence failure the guard exists to prevent. Assert a floor, and assert the scanner
  recognises a known-good site.

**Validate by breaking it:** change one `env: childEnv()` to `env: process.env`, confirm the guard
fails and names the exact file:line, then restore. A guard never seen failing is not evidence.

A full worked example (positive control, coverage assertion, mutation-verified) lives in the
knowfleet repo at `test/childEnvGuard.test.js`.

## Pitfalls

- **`node --check` only checks syntax.** It will happily pass a call to a function you just deleted.
  Verify a refactor by reading the call sites back, not by trusting a syntax check.
- **Edit tools can report success without persisting.** Read the region back before declaring a
  multi-site refactor done — an unpersisted edit that deletes a helper while leaving its call sites
  is a runtime break, not a cosmetic miss.
- **A `grep "a\|b"` read-back can lie.** Under a brokered/toybox `grep` there is no BRE `\|`
  alternation and it fails *silently* (no match, exit 1). Use `grep -E "a|b"`.
- **The MCP SDK stdio transport needs no help.** `StdioClientTransport` builds its child env from
  `DEFAULT_INHERITED_ENV_VARS = ['HOME','LOGNAME','PATH','SHELL','TERM','USER']`, which already
  excludes `NODE_OPTIONS`. Only **direct** spawns need `childEnv()`.
- **Do not fix this by wrapping the runner** (`env -u NODE_OPTIONS npm test`). That hides the defect
  from everyone who runs the suite the normal way. Fix the test files; keep the wrapper only as a
  diagnostic.

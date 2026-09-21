/**
 * Tests for the `ensure_checkout` extension to `@swamp/git`.
 *
 * These drive real `git` against local bare repositories — no network — because
 * the whole point of the method is how it behaves against the states a working
 * directory can actually be in.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { extension } from "./git_checkout.ts";
import { runCommand } from "./_lib/util.ts";

const method = extension.methods[0].ensure_checkout;

interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** A method context that records writes instead of persisting them. */
function testContext(repoDir: string) {
  const written: Written[] = [];
  return {
    written,
    ctx: {
      repoDir,
      signal: new AbortController().signal,
      logger: { info: () => {} },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runCommand("git", args, { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/**
 * Build a bare origin holding one commit on `main`, and return its `file://`
 * URL along with the scratch directory everything lives in.
 */
async function withOrigin(
  run: (origin: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "ensure-checkout-" });
  try {
    const bare = `${root}/origin.git`;
    await git(root, ["init", "--bare", "--initial-branch=main", bare]);

    const seed = `${root}/seed`;
    await Deno.mkdir(seed);
    await git(seed, ["init", "--initial-branch=main"]);
    await git(seed, ["config", "user.email", "test@example.com"]);
    await git(seed, ["config", "user.name", "Test"]);
    await Deno.writeTextFile(`${seed}/README.md`, "# seed\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-m", "seed"]);
    await git(seed, ["remote", "add", "origin", bare]);
    await git(seed, ["push", "-u", "origin", "main"]);

    await run(`file://${bare}`, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("the extension targets @swamp/git and declares its checkout spec", () => {
  assertEquals(extension.type, "@swamp/git");
  assertEquals(Object.keys(extension.resources), ["checkout"]);
  assertEquals(Object.keys(extension.methods[0]), ["ensure_checkout"]);
});

Deno.test("a missing path is cloned", async () => {
  await withOrigin(async (origin, root) => {
    const { ctx, written } = testContext(root);
    await method.execute(
      { url: origin, path: "work", depth: 1, reset: true },
      ctx,
    );

    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "checkout");
    assertEquals(written[0].data.action, "cloned");
    assertEquals(typeof written[0].data.sha, "string");
    assertEquals(
      await Deno.readTextFile(`${root}/work/README.md`),
      "# seed\n",
    );
  });
});

Deno.test("an existing checkout is updated, not re-cloned", async () => {
  await withOrigin(async (origin, root) => {
    const { ctx } = testContext(root);
    const args = { url: origin, path: "work", depth: 1, reset: true };

    await method.execute(args, ctx);
    const second = testContext(root);
    await method.execute(args, second.ctx);

    assertEquals(second.written[0].data.action, "updated");
  });
});

Deno.test("reset discards local changes; reset=false keeps them", async () => {
  await withOrigin(async (origin, root) => {
    const base = { url: origin, path: "work", depth: 1 };

    await method.execute({ ...base, reset: true }, testContext(root).ctx);
    await Deno.writeTextFile(`${root}/work/scratch.txt`, "generated\n");

    // reset=false leaves a previous run's output alone.
    const kept = testContext(root);
    await method.execute({ ...base, reset: false }, kept.ctx);
    assertEquals(kept.written[0].data.action, "reused");
    assertEquals(
      await Deno.readTextFile(`${root}/work/scratch.txt`),
      "generated\n",
    );

    // reset=true returns the tree to exactly what the remote holds.
    await method.execute({ ...base, reset: true }, testContext(root).ctx);
    let survived = true;
    try {
      await Deno.stat(`${root}/work/scratch.txt`);
    } catch {
      survived = false;
    }
    assertEquals(survived, false);
  });
});

Deno.test("the working branch is created once and reused on re-runs", async () => {
  await withOrigin(async (origin, root) => {
    const args = {
      url: origin,
      path: "work",
      depth: 1,
      reset: true,
      branch: "docs/mintlify",
    };

    const first = testContext(root);
    await method.execute(args, first.ctx);
    assertEquals(first.written[0].data.branch, "docs/mintlify");
    assertEquals(first.written[0].data.ref, "docs/mintlify");

    // `git checkout -b` would fail here; `-B` must not.
    const second = testContext(root);
    await method.execute(args, second.ctx);
    assertEquals(second.written[0].data.branch, "docs/mintlify");
  });
});

Deno.test("an empty branch string leaves the base ref checked out", async () => {
  await withOrigin(async (origin, root) => {
    const { ctx, written } = testContext(root);
    await method.execute(
      { url: origin, path: "work", depth: 1, reset: true, branch: "  " },
      ctx,
    );
    assertEquals(written[0].data.branch, null);
    assertEquals(written[0].data.ref, "main");
  });
});

Deno.test("an empty ref string is treated as unset, not passed to git", async () => {
  await withOrigin(async (origin, root) => {
    const { ctx, written } = testContext(root);
    // A literal `--branch ""` would make git fail; the empty string must be
    // normalised away, because workflow inputs cannot be conditionally omitted.
    await method.execute(
      { url: origin, path: "work", depth: 1, reset: true, ref: "" },
      ctx,
    );
    assertEquals(written[0].data.action, "cloned");
    assertEquals(written[0].data.ref, "main");
  });
});

Deno.test("a checkout of a different repository is refused", async () => {
  await withOrigin(async (origin, root) => {
    await method.execute(
      { url: origin, path: "work", depth: 1, reset: true },
      testContext(root).ctx,
    );

    // `reset` is destructive — pointing it at someone else's checkout must not
    // silently wipe it.
    const other = `${root}/other.git`;
    await git(root, ["init", "--bare", "--initial-branch=main", other]);

    let message = "";
    try {
      await method.execute(
        { url: `file://${other}`, path: "work", depth: 1, reset: true },
        testContext(root).ctx,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "Refusing to modify it");
    // The original checkout is intact.
    assertEquals(await Deno.readTextFile(`${root}/work/README.md`), "# seed\n");
  });
});

Deno.test("a non-empty directory that is not a checkout is refused", async () => {
  await withOrigin(async (origin, root) => {
    await Deno.mkdir(`${root}/work`);
    await Deno.writeTextFile(`${root}/work/keep.txt`, "important\n");

    let message = "";
    try {
      await method.execute(
        { url: origin, path: "work", depth: 1, reset: true },
        testContext(root).ctx,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "Refusing to clone over it");
    assertEquals(
      await Deno.readTextFile(`${root}/work/keep.txt`),
      "important\n",
    );
  });
});

Deno.test("an unreachable remote fails with git's own message", async () => {
  const root = await Deno.makeTempDir({ prefix: "ensure-checkout-" });
  try {
    let message = "";
    try {
      await method.execute(
        {
          url: `file://${root}/nope.git`,
          path: "work",
          depth: 1,
          reset: true,
        },
        testContext(root).ctx,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "git clone failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("credentials in the remote URL are scrubbed from stored data", async () => {
  await withOrigin(async (origin, root) => {
    const { ctx, written } = testContext(root);
    await method.execute(
      { url: origin, path: "work", depth: 1, reset: true },
      ctx,
    );
    // The recorded URL is what a later reader sees — it must never carry a
    // token, whatever was passed in.
    const stored = written[0].data.url as string;
    assertEquals(stored.includes("@"), false);
  });
});

Deno.test("a token requires an https URL", async () => {
  const root = await Deno.makeTempDir({ prefix: "ensure-checkout-" });
  try {
    let message = "";
    try {
      await method.execute(
        {
          url: "git@github.com:owner/name.git",
          path: "work",
          depth: 1,
          reset: true,
          token: "secret-token",
        },
        testContext(root).ctx,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "https:// URL");
    // The failure message must not echo the token back.
    assertEquals(message.includes("secret-token"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * Extends `@swamp/git` with an idempotent checkout method.
 *
 * `clone` fails when the destination already exists, which makes a re-runnable
 * documentation workflow awkward: every run would need the workspace cleared
 * first. `ensure_checkout` clones when the path is absent and fast-forwards an
 * existing checkout to the requested ref, so the same workflow can be run
 * repeatedly against the same repository — or against every repository in an
 * account — without special-casing the first run.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { isDirectory, joinPath, pathExists, runGit } from "./_lib/util.ts";
import { parseRepoSlug } from "./_lib/inspect.ts";

const EnsureCheckoutArgsSchema = z.object({
  url: z.string().min(1).describe("Repository URL to clone"),
  path: z.string().min(1).describe(
    "Destination path for the checkout, relative to the swamp repository or absolute",
  ),
  ref: z.string().optional().describe(
    "Branch or tag to check out (defaults to the remote's default branch). Empty string means unset, so workflows can always pass the input.",
  ),
  depth: z.number().int().min(0).default(1).describe(
    "Clone depth; 0 clones full history",
  ),
  reset: z.boolean().default(true).describe(
    "Discard local changes in an existing checkout and reset it to the remote ref. The checkout is a disposable workspace, so this defaults on for reproducible runs.",
  ),
  token: z.string().optional().meta({ sensitive: true }).describe(
    "Token for an authenticated HTTPS clone. Prefer ambient credentials (SSH agent or a git credential helper) where available.",
  ),
  branch: z.string().optional().describe(
    "Working branch to create or reset to the checked-out ref, so generated changes land on their own branch. Empty string means stay on the base ref.",
  ),
});

const CheckoutSchema = z.object({
  path: z.string(),
  url: z.string(),
  ref: z.string().nullable(),
  branch: z.string().nullable(),
  sha: z.string().nullable(),
  action: z.enum(["cloned", "updated", "reused"]),
  checkedOutAt: z.string(),
});

/** Minimal context shape this method uses. */
interface Ctx {
  readonly repoDir: string;
  readonly signal: AbortSignal;
  readonly logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/**
 * Inject a token into an https remote. Only https is supported — putting a
 * token in an ssh or git URL would leak it without authenticating anything.
 */
function authenticatedUrl(url: string, token: string): string {
  if (!url.startsWith("https://")) {
    throw new Error("token authentication requires an https:// URL");
  }
  const parsed = new URL(url);
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

/** Strip credentials before anything is logged or persisted. */
function scrubCredentials(text: string): string {
  return text.replace(/https:\/\/[^@\s]*@/g, "https://***@");
}

/** Two remote URLs point at the same repository. */
function sameRepository(a: string, b: string): boolean {
  const slugA = parseRepoSlug(a);
  const slugB = parseRepoSlug(b);
  if (slugA !== null && slugB !== null) return slugA === slugB;
  return a.replace(/\.git$/, "") === b.replace(/\.git$/, "");
}

/** Adds idempotent checkout to the official git model type. */
export const extension = {
  type: "@swamp/git",

  resources: {
    checkout: {
      description:
        "An idempotent working checkout — where it is, what ref it holds, and whether this run created or updated it",
      schema: CheckoutSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: [
    {
      ensure_checkout: {
        description:
          "Clone a repository, or bring an existing checkout at the same path up to date with the requested ref",
        arguments: EnsureCheckoutArgsSchema,
        execute: async (
          args: z.infer<typeof EnsureCheckoutArgsSchema>,
          ctx: Ctx,
        ): Promise<{ dataHandles: Array<{ name: string }> }> => {
          // Workflow inputs cannot be conditionally omitted, so optional
          // strings arrive as empty strings when unset.
          const ref = args.ref === undefined || args.ref.trim() === ""
            ? null
            : args.ref.trim();
          const token = args.token === undefined || args.token.trim() === ""
            ? null
            : args.token.trim();
          const remoteUrl = token === null
            ? args.url
            : authenticatedUrl(args.url, token);
          const target = args.path.startsWith("/")
            ? args.path
            : joinPath(ctx.repoDir, args.path);
          const safeUrl = scrubCredentials(args.url);
          const existing = await pathExists(joinPath(target, ".git"));

          let action: "cloned" | "updated" | "reused";

          if (!existing) {
            if (await isDirectory(target)) {
              const entries: string[] = [];
              for await (const entry of Deno.readDir(target)) {
                entries.push(entry.name);
                break;
              }
              if (entries.length > 0) {
                throw new Error(
                  `${args.path} already exists, is not a git checkout, and is ` +
                    `not empty. Refusing to clone over it.`,
                );
              }
            }

            const argv = ["clone"];
            if (args.depth > 0) argv.push("--depth", String(args.depth));
            if (ref !== null) argv.push("--branch", ref);
            argv.push("--", remoteUrl, target);

            const cloned = await runGit(ctx.repoDir, argv, ctx.signal);
            if (cloned.code !== 0) {
              throw new Error(
                `git clone failed (exit ${cloned.code}): ${
                  scrubCredentials(cloned.stderr.trim())
                }`,
              );
            }
            action = "cloned";
            ctx.logger.info("Cloned {url} to {path}", {
              url: safeUrl,
              path: args.path,
            });
          } else {
            // Never touch a checkout that belongs to a different repository —
            // `reset` below is destructive.
            const origin = await runGit(
              target,
              ["config", "--get", "remote.origin.url"],
              ctx.signal,
            );
            const originUrl = origin.stdout.trim();
            if (originUrl !== "" && !sameRepository(originUrl, args.url)) {
              throw new Error(
                `${args.path} is a checkout of ${
                  scrubCredentials(originUrl)
                }, not ${safeUrl}. Refusing to modify it.`,
              );
            }

            const fetchArgv = ["fetch", "--prune"];
            if (args.depth > 0) fetchArgv.push("--depth", String(args.depth));
            fetchArgv.push("origin");
            if (ref !== null) fetchArgv.push(ref);

            const fetched = await runGit(target, fetchArgv, ctx.signal);
            if (fetched.code !== 0) {
              throw new Error(
                `git fetch failed (exit ${fetched.code}): ${
                  scrubCredentials(fetched.stderr.trim())
                }`,
              );
            }

            if (args.reset) {
              const base = ref ?? await defaultBranch(target, ctx.signal);
              const checkedOut = await runGit(
                target,
                ["checkout", "--force", "-B", base, `origin/${base}`],
                ctx.signal,
              );
              if (checkedOut.code !== 0) {
                throw new Error(
                  `git checkout ${base} failed (exit ${checkedOut.code}): ${
                    scrubCredentials(checkedOut.stderr.trim())
                  }`,
                );
              }
              // Remove files left behind by an earlier run so the checkout
              // matches the remote exactly.
              await runGit(target, ["clean", "-fd"], ctx.signal);
              action = "updated";
            } else {
              action = "reused";
            }

            ctx.logger.info("Checkout at {path} is {action}", {
              path: args.path,
              action,
            });
          }

          // `checkout -B` creates the working branch or moves it onto the ref
          // just checked out, so re-running the workflow is a no-op rather than
          // a "branch already exists" failure.
          const working = args.branch === undefined || args.branch.trim() === ""
            ? null
            : args.branch.trim();
          if (working !== null) {
            const branched = await runGit(
              target,
              ["checkout", "-B", working],
              ctx.signal,
            );
            if (branched.code !== 0) {
              throw new Error(
                `git checkout -B ${working} failed (exit ${branched.code}): ${
                  scrubCredentials(branched.stderr.trim())
                }`,
              );
            }
            ctx.logger.info("Working branch {branch} ready at {path}", {
              branch: working,
              path: args.path,
            });
          }

          const sha = await runGit(target, ["rev-parse", "HEAD"], ctx.signal);
          const branch = await runGit(
            target,
            ["rev-parse", "--abbrev-ref", "HEAD"],
            ctx.signal,
          );

          const handle = await ctx.writeResource("checkout", "checkout", {
            path: target,
            url: safeUrl,
            ref: branch.code === 0 ? branch.stdout.trim() || null : null,
            branch: working,
            sha: sha.code === 0 ? sha.stdout.trim() || null : null,
            action,
            checkedOutAt: new Date().toISOString(),
          });

          return { dataHandles: [handle] };
        },
      },
    },
  ],
};

/** Resolve the remote's default branch, falling back to `main`. */
async function defaultBranch(
  target: string,
  signal: AbortSignal,
): Promise<string> {
  const head = await runGit(
    target,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    signal,
  );
  if (head.code === 0) {
    const value = head.stdout.trim().replace(/^origin\//, "");
    if (value !== "") return value;
  }
  const current = await runGit(
    target,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    signal,
  );
  const value = current.stdout.trim();
  return value === "" || value === "HEAD" ? "main" : value;
}

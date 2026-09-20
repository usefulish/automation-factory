/**
 * Mintlify documentation factory — turn any repository checkout into a
 * validated Mintlify documentation site.
 *
 * Five methods form the pipeline: `inspect` profiles the checkout, `plan`
 * derives the page set, `author` writes the pages with a locally installed
 * coding agent, `ensureConfig` reconciles `docs.json` against what landed on
 * disk, and `validate` gates the result against Mintlify's published schema
 * plus structural link, frontmatter, and reachability checks.
 *
 * Nothing here is specific to any one repository: every heuristic is derived
 * from the inspected profile, and every method is addressed at a checkout path
 * passed in as a method argument.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  AuthorArgsSchema,
  AuthorRunSchema,
  DocsConfigSchema,
  DocsPlanSchema,
  EnsureConfigArgsSchema,
  GlobalArgsSchema,
  InspectArgsSchema,
  PlanArgsSchema,
  RepoProfileSchema,
  ValidateArgsSchema,
  ValidationSchema,
} from "./_lib/schemas.ts";
import type { GlobalArgs } from "./_lib/schemas.ts";
import { buildRepoProfile } from "./_lib/inspect.ts";
import { buildDocsPlan } from "./_lib/plan.ts";
import { buildAuthorPrompt } from "./_lib/prompt.ts";
import { runAuthoringAgent } from "./_lib/author.ts";
import { ensureDocsConfig } from "./_lib/config.ts";
import { validateDocs } from "./_lib/validate.ts";
import { defaultCachePath, loadDocsSchema } from "./_lib/schema_source.ts";
import { isDirectory, joinPath, runCommand } from "./_lib/util.ts";
import type { DocsPlan, RepoProfile } from "./_lib/types.ts";

/** Data instance names are scoped per repository so one model serves many. */
const INSTANCE = {
  profile: (slug: string) => `profile-${slug}`,
  plan: (slug: string) => `plan-${slug}`,
  author: (slug: string) => `author-${slug}`,
  config: (slug: string) => `config-${slug}`,
  validation: (slug: string) => `validation-${slug}`,
  log: (slug: string) => `agentlog-${slug}`,
} as const;

/** Minimal shape of the method context fields these methods actually use. */
interface Ctx {
  readonly globalArgs: GlobalArgs;
  readonly repoDir: string;
  readonly definition: { readonly name: string };
  readonly signal: AbortSignal;
  readonly logger: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  readResource(
    instanceName: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
  createFileWriter(
    specName: string,
    name: string,
  ): { writeText(text: string): Promise<{ name: string }> };
  extensionFile(path: string): string;
}

/**
 * Workflow inputs cannot be conditionally omitted, so optional string arguments
 * are passed as empty strings when unset. Normalise that to "absent".
 */
function optional(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

/**
 * Resolve a caller-supplied checkout path against the swamp repository, the
 * way a CLI resolves user paths, and confirm it is a directory.
 */
async function resolveRepoPath(
  repoPath: string,
  repoDir: string,
): Promise<string> {
  const resolved = repoPath.startsWith("/")
    ? repoPath
    : joinPath(repoDir, repoPath);
  if (!await isDirectory(resolved)) {
    throw new Error(
      `repoPath "${repoPath}" does not resolve to a directory (looked at ${resolved})`,
    );
  }
  return resolved.replace(/\/+$/, "");
}

/**
 * Fail early and clearly when the agent CLI is missing, rather than surfacing a
 * bare ENOENT from deep inside the subprocess runner.
 */
async function assertAgentCliAvailable(cliPath: string): Promise<void> {
  try {
    const probe = await runCommand(cliPath, ["--version"], {
      timeoutMs: 30_000,
    });
    if (probe.code !== 0) {
      throw new Error(`"${cliPath} --version" exited ${probe.code}`);
    }
  } catch (error) {
    throw new Error(
      `The authoring agent CLI "${cliPath}" is not usable: ${
        error instanceof Error ? error.message : String(error)
      }. Install it and make sure it is on PATH and signed in, or set the ` +
        `agentCliPath global argument to its full path.`,
    );
  }
}

/** Read a previously written profile, failing with an actionable message. */
async function requireProfile(
  ctx: Ctx,
  slug: string,
): Promise<RepoProfile> {
  const stored = await ctx.readResource(INSTANCE.profile(slug));
  if (stored === null) {
    throw new Error(
      `No repository profile for "${slug}". Run the "inspect" method for this ` +
        `repository first.`,
    );
  }
  return stored as unknown as RepoProfile;
}

/** Read a previously written plan, failing with an actionable message. */
async function requirePlan(ctx: Ctx, slug: string): Promise<DocsPlan> {
  const stored = await ctx.readResource(INSTANCE.plan(slug));
  if (stored === null) {
    throw new Error(
      `No documentation plan for "${slug}". Run the "plan" method for this ` +
        `repository first.`,
    );
  }
  return stored as unknown as DocsPlan;
}

/** Mintlify documentation model — inspect, plan, author, configure, validate. */
export const model = {
  type: "@usefulish/mintlify",
  version: "2026.09.20.1",

  globalArguments: GlobalArgsSchema,

  // Runs after every method, including failed ones, so a failing validation
  // gate still renders its findings.
  reports: ["@usefulish/mintlify-docs"],

  resources: {
    repoProfile: {
      description:
        "Deterministic profile of an inspected repository — identity, languages, manifests, entrypoints, markdown outline, existing docs",
      schema: RepoProfileSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    docsPlan: {
      description:
        "The documentation page set derived from a repository profile, with per-page authoring briefs",
      schema: DocsPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    authorRun: {
      description:
        "Result of an authoring agent run — exit status, cost, and the docs files it changed",
      schema: AuthorRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    docsConfig: {
      description:
        "The reconciled Mintlify docs.json — navigation regenerated from the pages present on disk",
      schema: DocsConfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    validation: {
      description:
        "Documentation validation result — schema conformance, link integrity, frontmatter, and reachability findings",
      schema: ValidationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },

  files: {
    agentLog: {
      description: "Full stdout and stderr from an authoring agent run",
      contentType: "text/plain",
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    inspect: {
      description:
        "Profile a repository checkout — identity, languages, manifests, entrypoints, markdown outline, and any existing docs",
      arguments: InspectArgsSchema,
      execute: async (
        args: z.infer<typeof InspectArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoPath = await resolveRepoPath(args.repoPath, ctx.repoDir);
        const profile = await buildRepoProfile({
          repoPath,
          docsDir: ctx.globalArgs.docsDir,
          signal: ctx.signal,
        });

        ctx.logger.info(
          "Inspected {repo}: {files} files, kind={kind}, language={language}",
          {
            repo: profile.repo ?? profile.name,
            files: profile.fileCount,
            kind: profile.kind,
            language: profile.primaryLanguage ?? "unknown",
          },
        );

        const handle = await ctx.writeResource(
          "repoProfile",
          INSTANCE.profile(profile.slug),
          profile as unknown as Record<string, unknown>,
        );
        return { dataHandles: [handle] };
      },
    },

    plan: {
      description:
        "Derive the documentation page set and per-page authoring briefs from the repository profile",
      arguments: PlanArgsSchema,
      execute: async (
        args: z.infer<typeof PlanArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoPath = await resolveRepoPath(args.repoPath, ctx.repoDir);
        const profile = await buildRepoProfile({
          repoPath,
          docsDir: ctx.globalArgs.docsDir,
          signal: ctx.signal,
        });

        const plan = buildDocsPlan({
          profile,
          siteName: optional(args.siteName),
          theme: args.theme ?? ctx.globalArgs.theme,
          colors: {
            primary: ctx.globalArgs.primaryColor,
            light: ctx.globalArgs.lightColor,
            dark: ctx.globalArgs.darkColor,
          },
        });

        ctx.logger.info("Planned {pages} page(s) in {groups} group(s)", {
          pages: plan.pageCount,
          groups: plan.groups.length,
        });

        // The profile is refreshed here too so `author` never works from a
        // profile that predates the plan it is paired with.
        const profileHandle = await ctx.writeResource(
          "repoProfile",
          INSTANCE.profile(profile.slug),
          profile as unknown as Record<string, unknown>,
        );
        const planHandle = await ctx.writeResource(
          "docsPlan",
          INSTANCE.plan(plan.slug),
          plan as unknown as Record<string, unknown>,
        );
        return { dataHandles: [profileHandle, planHandle] };
      },
    },

    author: {
      description:
        "Write the planned documentation pages using a locally installed coding agent, scoped to the checkout with no command-execution tools",
      arguments: AuthorArgsSchema,
      execute: async (
        args: z.infer<typeof AuthorArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoPath = await resolveRepoPath(args.repoPath, ctx.repoDir);
        const slug = (await buildRepoProfile({
          repoPath,
          docsDir: ctx.globalArgs.docsDir,
          signal: ctx.signal,
        })).slug;

        const profile = await requireProfile(ctx, slug);
        const plan = await requirePlan(ctx, slug);

        await assertAgentCliAvailable(ctx.globalArgs.agentCliPath);

        const prompt = buildAuthorPrompt({
          profile,
          plan,
          extraInstructions: optional(args.instructions),
          overwrite: args.overwrite,
        });

        ctx.logger.info(
          "Authoring {pages} page(s) for {repo} with {cli}",
          {
            pages: plan.pageCount,
            repo: plan.repo ?? slug,
            cli: ctx.globalArgs.agentCliPath,
          },
        );

        const result = await runAuthoringAgent({
          repoPath,
          docsDir: plan.docsDir,
          prompt,
          cliPath: ctx.globalArgs.agentCliPath,
          model: optional(args.model) ?? ctx.globalArgs.agentModel ?? null,
          timeoutMs: args.timeoutMs ?? ctx.globalArgs.agentTimeoutMs,
          signal: ctx.signal,
        });

        // The log is written before any failure is raised so a timed-out or
        // erroring run is still diagnosable.
        const logWriter = ctx.createFileWriter("agentLog", INSTANCE.log(slug));
        const logHandle = await logWriter.writeText(result.log);

        const runHandle = await ctx.writeResource(
          "authorRun",
          INSTANCE.author(slug),
          {
            slug,
            repo: plan.repo,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            provider: result.provider,
            model: result.model,
            sessionId: result.sessionId,
            costUsd: result.costUsd,
            numTurns: result.numTurns,
            permissionDenials: result.permissionDenials,
            filesChanged: result.changedFiles.length,
            changedFiles: result.changedFiles,
            summary: result.summary,
            ranAt: new Date().toISOString(),
          },
        );

        if (result.timedOut) {
          throw new Error(
            `Authoring agent timed out after ${result.durationMs}ms. Raise ` +
              `agentTimeoutMs or narrow the plan.`,
          );
        }
        if (result.exitCode !== 0) {
          throw new Error(
            `Authoring agent exited ${result.exitCode}. See the agentLog data ` +
              `output for the full transcript.`,
          );
        }
        if (result.changedFiles.length === 0) {
          throw new Error(
            `Authoring agent wrote no documentation files. See the agentLog ` +
              `data output — the run may have been denied a tool it needed.`,
          );
        }

        ctx.logger.info("Agent wrote {files} file(s) in {ms}ms", {
          files: result.changedFiles.length,
          ms: result.durationMs,
        });

        return { dataHandles: [runHandle, logHandle] };
      },
    },

    ensureConfig: {
      description:
        "Create or update docs.json, regenerating navigation from the documentation pages present on disk",
      arguments: EnsureConfigArgsSchema,
      execute: async (
        args: z.infer<typeof EnsureConfigArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoPath = await resolveRepoPath(args.repoPath, ctx.repoDir);
        const slug = (await buildRepoProfile({
          repoPath,
          docsDir: ctx.globalArgs.docsDir,
          signal: ctx.signal,
        })).slug;
        const plan = await requirePlan(ctx, slug);

        const result = await ensureDocsConfig({
          repoPath,
          plan,
          force: args.force,
          dryRun: args.dryRun,
        });

        if (result.plannedMissing.length > 0) {
          ctx.logger.warning(
            "{count} planned page(s) were never written and are omitted from navigation: {pages}",
            {
              count: result.plannedMissing.length,
              pages: result.plannedMissing.join(", "),
            },
          );
        }

        ctx.logger.info(
          "{action} {config}: {pages} page(s) in {groups} group(s)",
          {
            action: result.created
              ? "Created"
              : result.changed
              ? "Updated"
              : "Left unchanged",
            config: result.configPath,
            pages: result.pageCount,
            groups: result.groupCount,
          },
        );

        const navigation = (result.config.navigation as {
          groups: Array<{ group: string; pages: string[] }>;
        })
          .groups;

        const handle = await ctx.writeResource(
          "docsConfig",
          INSTANCE.config(slug),
          {
            slug,
            repo: plan.repo,
            configPath: result.configPath,
            created: result.created,
            changed: result.changed,
            pageCount: result.pageCount,
            groupCount: result.groupCount,
            orphansAdopted: result.orphansAdopted,
            plannedMissing: result.plannedMissing,
            navigation,
            writtenAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    validate: {
      description:
        "Validate docs.json against Mintlify's published schema and check page frontmatter, internal links, assets, and navigation reachability",
      arguments: ValidateArgsSchema,
      execute: async (
        args: z.infer<typeof ValidateArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const repoPath = await resolveRepoPath(args.repoPath, ctx.repoDir);
        const profile = await buildRepoProfile({
          repoPath,
          docsDir: ctx.globalArgs.docsDir,
          signal: ctx.signal,
        });

        const loaded = await loadDocsSchema({
          url: ctx.globalArgs.schemaUrl,
          cachePath: defaultCachePath(ctx.repoDir),
          cacheTtlHours: ctx.globalArgs.schemaCacheTtlHours,
          bundledPath: ctx.extensionFile("docs-schema.json"),
          offline: args.offline,
          signal: ctx.signal,
        });
        if (loaded.note !== null) {
          ctx.logger.warning("Mintlify schema: {note}", { note: loaded.note });
        }

        const result = await validateDocs({
          repoPath,
          docsDir: profile.docs.dir,
          configPath: profile.docs.configPath,
          schema: loaded.schema,
          schemaOrigin: loaded.origin,
          strict: args.strict,
        });

        const handle = await ctx.writeResource(
          "validation",
          INSTANCE.validation(profile.slug),
          {
            slug: profile.slug,
            repo: profile.repo,
            ok: result.ok,
            errorCount: result.errorCount,
            warningCount: result.warningCount,
            pageCount: result.pageCount,
            configPath: result.configPath,
            schemaOrigin: result.schemaOrigin,
            schemaNote: loaded.note,
            issues: result.issues,
            checkedAt: result.checkedAt,
          },
        );

        ctx.logger.info(
          "Validated {pages} page(s): {errors} error(s), {warnings} warning(s)",
          {
            pages: result.pageCount,
            errors: result.errorCount,
            warnings: result.warningCount,
          },
        );

        // The findings are the deliverable, so they are persisted before the
        // gate fires — a failing run stays inspectable via `swamp data get`.
        if (args.failOnError && !result.ok) {
          const preview = result.issues
            .filter((i) => i.severity === "error")
            .slice(0, 5)
            .map((i) =>
              `  - [${i.kind}] ${i.file ?? "docs.json"}: ${i.message}`
            )
            .join("\n");
          throw new Error(
            `Documentation validation failed with ${result.errorCount} error(s):\n` +
              `${preview}\n` +
              `Full report: swamp data get ${ctx.definition.name} ` +
              `${INSTANCE.validation(profile.slug)} --json`,
          );
        }

        return { dataHandles: [handle] };
      },
    },
  },
};

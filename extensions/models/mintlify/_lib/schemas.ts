/**
 * Zod schemas for global arguments, method arguments, and resource outputs.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Themes accepted by Mintlify's published config schema. */
export const MINTLIFY_THEMES = [
  "mint",
  "maple",
  "palm",
  "willow",
  "linden",
  "almond",
  "aspen",
  "luma",
  "sequoia",
] as const;

/** Coding-agent CLIs with a supported authoring adapter. */
export const AUTHOR_PROVIDERS = ["claude", "codex"] as const;

const HEX_COLOR = /^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/;

/** Global arguments — stable across repositories, all optional with defaults. */
export const GlobalArgsSchema = z.object({
  docsDir: z.string().min(1).default("docs").describe(
    "Documentation directory inside the target repository. Use '.' to place docs.json at the repository root.",
  ),
  theme: z.enum(MINTLIFY_THEMES).default("mint").describe(
    "Mintlify theme applied to newly created configs",
  ),
  primaryColor: z.string().regex(HEX_COLOR).default("#0D9373").describe(
    "Primary brand colour (hex)",
  ),
  lightColor: z.string().regex(HEX_COLOR).default("#07C983").describe(
    "Colour used as primary in dark mode (hex)",
  ),
  darkColor: z.string().regex(HEX_COLOR).default("#0D9373").describe(
    "Colour used as primary in light mode (hex)",
  ),
  agentProvider: z.enum(AUTHOR_PROVIDERS).default("claude").describe(
    "Coding-agent provider used for authoring",
  ),
  agentCliPath: z.string().default("").describe(
    "Optional authoring CLI executable override. Empty uses the provider default.",
  ),
  agentModel: z.string().min(1).optional().describe(
    "Model the authoring agent should use (defaults to the CLI's own default)",
  ),
  agentTimeoutMs: z.number().int().positive().default(1_800_000).describe(
    "Wall-clock timeout for a single authoring run",
  ),
  schemaUrl: z.url().default("https://mintlify.com/docs.json").describe(
    "URL of the official Mintlify docs.json JSON Schema",
  ),
  schemaCacheTtlHours: z.number().int().min(0).default(24).describe(
    "How long a fetched schema stays fresh before it is re-fetched",
  ),
}).describe("Documentation-factory settings shared across repositories");

/** Validated global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Every method is addressed at one checkout. */
const RepoPathArg = z.string().min(1).describe(
  "Path to the repository checkout to operate on (absolute, or relative to the swamp repository)",
);

/** Arguments for `inspect`. */
export const InspectArgsSchema = z.object({
  repoPath: RepoPathArg,
});

/** Arguments for `plan`. */
export const PlanArgsSchema = z.object({
  repoPath: RepoPathArg,
  siteName: z.string().optional().describe(
    "Documentation site name (defaults to the repository name). Empty string means unset, so workflows can always pass the input.",
  ),
  theme: z.enum(MINTLIFY_THEMES).optional().describe(
    "Override the configured theme for this repository",
  ),
});

/** Arguments for `author`. */
export const AuthorArgsSchema = z.object({
  repoPath: RepoPathArg,
  provider: z.enum(AUTHOR_PROVIDERS).optional().describe(
    "Override the configured authoring provider for this run",
  ),
  cliPath: z.string().optional().describe(
    "Override the configured authoring CLI executable for this run. Empty string means unset.",
  ),
  instructions: z.string().optional().describe(
    "Extra authoring guidance appended to the generated brief. Empty string means unset.",
  ),
  model: z.string().optional().describe(
    "Override the configured authoring model for this run. Empty string means unset.",
  ),
  overwrite: z.boolean().default(false).describe(
    "Rewrite pages that already exist instead of leaving accurate ones alone",
  ),
  timeoutMs: z.number().int().positive().optional().describe(
    "Override the configured authoring timeout for this run",
  ),
});

/** Arguments for `ensureConfig`. */
export const EnsureConfigArgsSchema = z.object({
  repoPath: RepoPathArg,
  force: z.boolean().default(false).describe(
    "Overwrite theme, name, and colours even when the existing config sets them",
  ),
  dryRun: z.boolean().default(false).describe(
    "Compute the config without writing docs.json",
  ),
});

/** Arguments for `validate`. */
export const ValidateArgsSchema = z.object({
  repoPath: RepoPathArg,
  strict: z.boolean().default(true).describe(
    "Treat orphan pages and missing descriptions as errors rather than warnings",
  ),
  failOnError: z.boolean().default(true).describe(
    "Fail the method (and any workflow step) when validation finds errors. The report is written either way.",
  ),
  offline: z.boolean().default(false).describe(
    "Skip fetching the published schema and use the cached or bundled copy",
  ),
});

const HeadingSchema = z.object({
  level: z.number().int(),
  title: z.string(),
  slug: z.string(),
});

/** `repoProfile` resource — the deterministic repository inspection. */
export const RepoProfileSchema = z.object({
  repo: z.string().nullable(),
  slug: z.string(),
  repoPath: z.string(),
  remote: z.string().nullable(),
  headSha: z.string().nullable(),
  branch: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(["cli", "library", "service", "configuration"]),
  primaryLanguage: z.string().nullable(),
  fileCount: z.number().int(),
  totalBytes: z.number().int(),
  truncated: z.boolean(),
  topLevelEntries: z.array(z.string()),
  languages: z.array(z.object({
    language: z.string(),
    files: z.number().int(),
    bytes: z.number().int(),
  })),
  manifests: z.array(z.object({
    path: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    version: z.string().nullable(),
    description: z.string().nullable(),
    scripts: z.array(z.string()),
    binaries: z.array(z.string()),
  })),
  entrypoints: z.array(z.object({
    path: z.string(),
    interpreter: z.string().nullable(),
    bytes: z.number().int(),
    summary: z.string().nullable(),
  })),
  markdown: z.array(z.object({
    path: z.string(),
    title: z.string(),
    headings: z.array(HeadingSchema),
    bytes: z.number().int(),
    truncated: z.boolean(),
    excerpt: z.string().nullable(),
  })),
  ci: z.array(z.object({ path: z.string(), name: z.string() })),
  docs: z.object({
    dir: z.string(),
    exists: z.boolean(),
    configPath: z.string(),
    configPresent: z.boolean(),
    legacyMintJson: z.boolean(),
    pages: z.array(z.string()),
  }),
  license: z.string().nullable(),
  inspectedAt: z.string(),
});

/** `docsPlan` resource — the page set the agent is briefed to write. */
export const DocsPlanSchema = z.object({
  slug: z.string(),
  repo: z.string().nullable(),
  siteName: z.string(),
  theme: z.string(),
  colors: z.object({
    primary: z.string(),
    light: z.string(),
    dark: z.string(),
  }),
  docsDir: z.string(),
  configPath: z.string(),
  groups: z.array(z.object({
    group: z.string(),
    pages: z.array(z.object({
      path: z.string(),
      file: z.string(),
      title: z.string(),
      description: z.string(),
      purpose: z.string(),
      sources: z.array(z.string()),
    })),
  })),
  pageCount: z.number().int(),
  rationale: z.string(),
  plannedAt: z.string(),
});

/** `authorRun` resource — what the authoring agent did. */
export const AuthorRunSchema = z.object({
  slug: z.string(),
  repo: z.string().nullable(),
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  durationMs: z.number().int(),
  provider: z.string(),
  model: z.string().nullable(),
  sessionId: z.string().nullable(),
  costUsd: z.number().nullable(),
  numTurns: z.number().int().nullable(),
  permissionDenials: z.number().int(),
  filesChanged: z.number().int(),
  changedFiles: z.array(z.object({
    path: z.string(),
    change: z.enum(["added", "modified"]),
    bytes: z.number().int(),
  })),
  summary: z.string(),
  ranAt: z.string(),
});

/** `docsConfig` resource — the reconciled docs.json. */
export const DocsConfigSchema = z.object({
  slug: z.string(),
  repo: z.string().nullable(),
  configPath: z.string(),
  created: z.boolean(),
  changed: z.boolean(),
  pageCount: z.number().int(),
  groupCount: z.number().int(),
  orphansAdopted: z.array(z.string()),
  plannedMissing: z.array(z.string()),
  navigation: z.array(z.object({
    group: z.string(),
    pages: z.array(z.string()),
  })),
  writtenAt: z.string(),
});

/** `validation` resource — the documentation quality gate result. */
export const ValidationSchema = z.object({
  slug: z.string(),
  repo: z.string().nullable(),
  ok: z.boolean(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  pageCount: z.number().int(),
  configPath: z.string(),
  schemaOrigin: z.string(),
  schemaNote: z.string().nullable(),
  issues: z.array(z.object({
    severity: z.enum(["error", "warning"]),
    kind: z.string(),
    file: z.string().nullable(),
    message: z.string(),
  })),
  checkedAt: z.string(),
});

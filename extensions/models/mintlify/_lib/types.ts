/**
 * Shared TypeScript types for the Mintlify documentation model.
 *
 * These mirror the Zod resource schemas in `schemas.ts`; the Zod schemas remain
 * the single source of truth for validation, these types for internal plumbing.
 *
 * @module
 */

/** A markdown ATX heading. */
export interface Heading {
  readonly level: number;
  readonly title: string;
  readonly slug: string;
}

/** Identity derived from a checkout's git metadata. */
export interface RepoIdentity {
  readonly remote: string | null;
  readonly repo: string | null;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly name: string;
  readonly slug: string;
}

/** Per-language file and byte counts. */
export interface LanguageStat {
  readonly language: string;
  readonly files: number;
  readonly bytes: number;
}

/** A dependency/package manifest discovered near the repository root. */
export interface PackageManifest {
  path: string;
  kind: string;
  name: string | null;
  version: string | null;
  description: string | null;
  scripts: string[];
  binaries: string[];
}

/** An executable script or command entrypoint. */
export interface Entrypoint {
  readonly path: string;
  readonly interpreter: string | null;
  readonly bytes: number;
  readonly summary: string | null;
}

/** A markdown document outside the docs directory (README, CHANGELOG, …). */
export interface MarkdownDoc {
  readonly path: string;
  readonly title: string;
  readonly headings: Heading[];
  readonly bytes: number;
  readonly truncated: boolean;
  readonly excerpt: string | null;
}

/** A continuous-integration workflow definition. */
export interface CiWorkflow {
  readonly path: string;
  readonly name: string;
}

/** Structured profile of an inspected repository. */
export interface RepoProfile {
  readonly repo: string | null;
  readonly slug: string;
  readonly repoPath: string;
  readonly remote: string | null;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly kind: "cli" | "library" | "service" | "configuration";
  readonly primaryLanguage: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly topLevelEntries: string[];
  readonly languages: LanguageStat[];
  readonly manifests: PackageManifest[];
  readonly entrypoints: Entrypoint[];
  readonly markdown: MarkdownDoc[];
  readonly ci: CiWorkflow[];
  readonly docs: {
    readonly dir: string;
    readonly exists: boolean;
    readonly configPath: string;
    readonly configPresent: boolean;
    readonly legacyMintJson: boolean;
    readonly pages: string[];
  };
  readonly license: string | null;
  readonly inspectedAt: string;
}

/** A single planned documentation page. */
export interface PlannedPage {
  /** Navigation path, relative to docs.json, without extension. */
  readonly path: string;
  /** Path on disk relative to the repository root. */
  readonly file: string;
  readonly title: string;
  readonly description: string;
  /** What this page must cover — handed to the authoring agent verbatim. */
  readonly purpose: string;
  /** Repository files the page should be written from. */
  readonly sources: string[];
}

/** A navigation group of planned pages. */
export interface PlannedGroup {
  readonly group: string;
  readonly pages: PlannedPage[];
}

/** The documentation plan derived from a repository profile. */
export interface DocsPlan {
  readonly slug: string;
  readonly repo: string | null;
  readonly siteName: string;
  readonly theme: string;
  readonly colors: { primary: string; light: string; dark: string };
  readonly docsDir: string;
  readonly configPath: string;
  readonly groups: PlannedGroup[];
  readonly pageCount: number;
  readonly rationale: string;
  readonly plannedAt: string;
}

/** Severity of a validation issue. */
export type IssueSeverity = "error" | "warning";

/** A single documentation validation finding. */
export interface ValidationIssue {
  readonly severity: IssueSeverity;
  /** Stable machine-readable category, e.g. `schema`, `missing-page`. */
  readonly kind: string;
  /** Repository-relative file the issue is anchored to, when known. */
  readonly file: string | null;
  readonly message: string;
}

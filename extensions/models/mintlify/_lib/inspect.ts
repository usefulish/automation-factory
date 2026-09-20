/**
 * Deterministic repository inspection.
 *
 * Produces a structured profile of an arbitrary checkout — identity, languages,
 * package manifests, entrypoints, existing docs, markdown outline — with no
 * language-specific or repository-specific assumptions baked in. The profile is
 * both the grounding context handed to the authoring agent and the input the
 * documentation plan is derived from.
 *
 * @module
 */

import {
  baseName,
  extName,
  fileSize,
  joinPath,
  listRepoFiles,
  pathExists,
  readTextCapped,
  runGit,
  slugify,
  stripDocExtension,
} from "./util.ts";
import type {
  CiWorkflow,
  Entrypoint,
  Heading,
  LanguageStat,
  MarkdownDoc,
  PackageManifest,
  RepoIdentity,
  RepoProfile,
} from "./types.ts";

/** Extension → human language name. Covers the long tail well enough to rank. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  hpp: "C++",
  cs: "C#",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  ps1: "PowerShell",
  sql: "SQL",
  scala: "Scala",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  lua: "Lua",
  dart: "Dart",
  r: "R",
  jl: "Julia",
  tf: "Terraform",
  hcl: "HCL",
  sb: "Sandbox policy",
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  toml: "TOML",
  ini: "INI",
  md: "Markdown",
  mdx: "MDX",
  html: "HTML",
  css: "CSS",
  scss: "CSS",
};

/** Extensions that are configuration/markup rather than implementation. */
const NON_CODE_LANGUAGES = new Set([
  "YAML",
  "JSON",
  "TOML",
  "INI",
  "Markdown",
  "MDX",
  "HTML",
  "CSS",
]);

/** Manifest filename → ecosystem label. */
const MANIFEST_KINDS: Record<string, string> = {
  "package.json": "npm",
  "deno.json": "deno",
  "deno.jsonc": "deno",
  "pyproject.toml": "python",
  "setup.py": "python",
  "requirements.txt": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "Gemfile": "ruby",
  "composer.json": "php",
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  "mix.exs": "elixir",
  "pubspec.yaml": "dart",
  "Package.swift": "swift",
  "CMakeLists.txt": "cmake",
  "Makefile": "make",
  "Dockerfile": "docker",
  "docker-compose.yml": "docker",
  "flake.nix": "nix",
};

const MAX_FILES = 6000;
const MAX_MARKDOWN_BYTES = 256 * 1024;
const MAX_SCRIPT_PEEK_BYTES = 8 * 1024;

/** Options accepted by {@linkcode buildRepoProfile}. */
export interface InspectOptions {
  readonly repoPath: string;
  readonly docsDir: string;
  readonly signal?: AbortSignal;
}

/**
 * Inspect a checkout and return its structured profile.
 *
 * @param opts Absolute checkout path plus the docs subdirectory to look in.
 * @returns The repository profile.
 */
export async function buildRepoProfile(
  opts: InspectOptions,
): Promise<RepoProfile> {
  const { repoPath, docsDir, signal } = opts;

  const identity = await readIdentity(repoPath, signal);
  const files = await listRepoFiles(repoPath, MAX_FILES, signal);

  const sizes = new Map<string, number>();
  let totalBytes = 0;
  for (const rel of files) {
    const size = await fileSize(joinPath(repoPath, rel));
    sizes.set(rel, size);
    totalBytes += size;
  }

  const languages = rankLanguages(files, sizes);
  const manifests = await readManifests(repoPath, files);
  const entrypoints = await readEntrypoints(repoPath, files, sizes);
  const markdown = await readMarkdown(repoPath, files, docsDir);
  const ci = readCi(files);
  const docs = await readExistingDocs(repoPath, docsDir, files);
  const license = detectLicense(files);

  const topLevel = Array.from(
    new Set(files.map((f) => (f.includes("/") ? `${f.split("/")[0]}/` : f))),
  ).sort();

  const readme = markdown.find((m) => /^readme\.mdx?$/i.test(baseName(m.path)));

  return {
    repo: identity.repo,
    slug: identity.slug,
    repoPath,
    remote: identity.remote,
    headSha: identity.headSha,
    branch: identity.branch,
    name: identity.name,
    description: deriveDescription(manifests, readme),
    kind: classifyKind(manifests, entrypoints, languages, files),
    primaryLanguage: languages.find((l) => !NON_CODE_LANGUAGES.has(l.language))
      ?.language ?? languages[0]?.language ?? null,
    fileCount: files.length,
    totalBytes,
    truncated: files.length >= MAX_FILES,
    topLevelEntries: topLevel,
    languages,
    manifests,
    entrypoints,
    markdown,
    ci,
    docs,
    license,
    inspectedAt: new Date().toISOString(),
  };
}

async function readIdentity(
  repoPath: string,
  signal?: AbortSignal,
): Promise<RepoIdentity> {
  const remoteResult = await runGit(
    repoPath,
    ["config", "--get", "remote.origin.url"],
    signal,
  );
  const remote = remoteResult.code === 0
    ? remoteResult.stdout.trim() || null
    : null;

  const shaResult = await runGit(repoPath, ["rev-parse", "HEAD"], signal);
  const headSha = shaResult.code === 0 ? shaResult.stdout.trim() || null : null;

  const branchResult = await runGit(
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    signal,
  );
  const branch = branchResult.code === 0
    ? branchResult.stdout.trim() || null
    : null;

  const repo = remote === null ? null : parseRepoSlug(remote);
  const name = repo === null ? baseName(repoPath) : repo.split("/")[1];

  return {
    remote,
    repo,
    headSha,
    branch,
    name,
    slug: slugify(repo ?? baseName(repoPath)),
  };
}

/**
 * Extract `owner/name` from any common git remote spelling
 * (`https://host/o/n.git`, `git@host:o/n.git`, `ssh://git@host/o/n`).
 *
 * @param remote The configured remote URL.
 * @returns `owner/name`, or null when the URL has no recognisable pair.
 */
export function parseRepoSlug(remote: string): string | null {
  const cleaned = remote.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const scp = cleaned.match(/^[^@]+@[^:]+:(.+)$/);
  const candidate = scp !== null
    ? scp[1]
    : cleaned.replace(/^[a-z+]+:\/\/[^/]+\//i, "");
  const parts = candidate.split("/").filter((p) => p !== "");
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function rankLanguages(
  files: string[],
  sizes: Map<string, number>,
): LanguageStat[] {
  const byLanguage = new Map<string, { files: number; bytes: number }>();
  for (const rel of files) {
    const language = LANGUAGE_BY_EXT[extName(rel)];
    if (language === undefined) continue;
    const entry = byLanguage.get(language) ?? { files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += sizes.get(rel) ?? 0;
    byLanguage.set(language, entry);
  }
  return Array.from(byLanguage.entries())
    .map(([language, stat]) => ({ language, ...stat }))
    .sort((a, b) => b.bytes - a.bytes || b.files - a.files)
    .slice(0, 12);
}

async function readManifests(
  repoPath: string,
  files: string[],
): Promise<PackageManifest[]> {
  const out: PackageManifest[] = [];
  for (const rel of files) {
    const kind = MANIFEST_KINDS[baseName(rel)];
    if (kind === undefined) continue;
    if (rel.split("/").length > 3) continue;

    const manifest: PackageManifest = {
      path: rel,
      kind,
      name: null,
      version: null,
      description: null,
      scripts: [],
      binaries: [],
    };

    if (baseName(rel).endsWith(".json")) {
      const read = await readTextCapped(
        joinPath(repoPath, rel),
        MAX_SCRIPT_PEEK_BYTES * 8,
      );
      if (read !== null && !read.truncated) {
        try {
          const parsed = JSON.parse(read.text) as Record<string, unknown>;
          manifest.name = asString(parsed.name);
          manifest.version = asString(parsed.version);
          manifest.description = asString(parsed.description);
          if (isRecord(parsed.scripts)) {
            manifest.scripts = Object.keys(parsed.scripts).slice(0, 40);
          }
          if (isRecord(parsed.bin)) {
            manifest.binaries = Object.keys(parsed.bin).slice(0, 20);
          } else if (typeof parsed.bin === "string") {
            manifest.binaries = [parsed.bin];
          }
        } catch {
          // A malformed manifest is still worth reporting by path alone.
        }
      }
    }

    out.push(manifest);
    if (out.length >= 20) break;
  }
  return out;
}

async function readEntrypoints(
  repoPath: string,
  files: string[],
  sizes: Map<string, number>,
): Promise<Entrypoint[]> {
  const out: Entrypoint[] = [];
  for (const rel of files) {
    const depth = rel.split("/").length;
    const ext = extName(rel);
    const looksExecutable = ext === "sh" || ext === "bash" || ext === "zsh" ||
      depth === 1 && ext === "";
    const inBinDir = /^(bin|scripts|cmd)\//.test(rel);
    if (!looksExecutable && !inBinDir) continue;
    if (depth > 2) continue;

    const read = await readTextCapped(
      joinPath(repoPath, rel),
      MAX_SCRIPT_PEEK_BYTES,
    );
    if (read === null) continue;
    const lines = read.text.split("\n");
    const shebang = lines[0]?.startsWith("#!")
      ? lines[0].slice(2).trim()
      : null;
    if (shebang === null && !looksExecutable && !inBinDir) continue;

    out.push({
      path: rel,
      interpreter: shebang,
      bytes: sizes.get(rel) ?? 0,
      summary: leadingComment(lines),
    });
    if (out.length >= 30) break;
  }
  return out;
}

/** First contiguous run of `#` comments after the shebang, joined into a line. */
function leadingComment(lines: string[]): string | null {
  const collected: string[] = [];
  for (const raw of lines.slice(lines[0]?.startsWith("#!") ? 1 : 0, 25)) {
    const line = raw.trim();
    if (line === "" && collected.length === 0) continue;
    if (!line.startsWith("#")) break;
    const text = line.replace(/^#+\s?/, "").trim();
    if (text === "") {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(text);
    if (collected.length >= 4) break;
  }
  return collected.length === 0 ? null : collected.join(" ");
}

async function readMarkdown(
  repoPath: string,
  files: string[],
  docsDir: string,
): Promise<MarkdownDoc[]> {
  const candidates = files.filter((rel) => {
    const ext = extName(rel);
    if (ext !== "md" && ext !== "mdx") return false;
    if (docsDir !== "." && rel.startsWith(`${docsDir}/`)) return false;
    return rel.split("/").length <= 3;
  });

  const out: MarkdownDoc[] = [];
  for (const rel of candidates) {
    const read = await readTextCapped(
      joinPath(repoPath, rel),
      MAX_MARKDOWN_BYTES,
    );
    if (read === null) continue;
    const headings = parseHeadings(read.text);
    out.push({
      path: rel,
      title: headings.find((h) => h.level === 1)?.title ??
        stripDocExtension(baseName(rel)),
      headings: headings.slice(0, 60),
      bytes: read.text.length,
      truncated: read.truncated,
      excerpt: firstParagraph(read.text),
    });
    if (out.length >= 25) break;
  }

  // README first — every downstream heuristic treats it as the canonical source.
  out.sort((a, b) => {
    const aReadme = /^readme\.mdx?$/i.test(baseName(a.path)) ? 0 : 1;
    const bReadme = /^readme\.mdx?$/i.test(baseName(b.path)) ? 0 : 1;
    return aReadme - bReadme || a.path.localeCompare(b.path);
  });
  return out;
}

/** Parse ATX headings, skipping anything inside a fenced code block. */
export function parseHeadings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const fence = line.match(/^(```+|~~~+)/);
    if (fence !== null) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading === null) continue;
    const title = heading[2].replace(/`/g, "").trim();
    if (title === "") continue;
    out.push({ level: heading[1].length, title, slug: slugify(title) });
  }
  return out;
}

/** First non-heading, non-blockquote, non-fence paragraph, capped for prompts. */
function firstParagraph(markdown: string): string | null {
  const lines = markdown.split("\n");
  const buffer: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === "") {
      if (buffer.length > 0) break;
      continue;
    }
    if (line.startsWith("#") || line.startsWith(">") || line.startsWith("|")) {
      if (buffer.length > 0) break;
      continue;
    }
    buffer.push(line);
    if (buffer.join(" ").length > 400) break;
  }
  const text = buffer.join(" ").trim();
  return text === "" ? null : text.slice(0, 400);
}

function readCi(files: string[]): CiWorkflow[] {
  return files
    .filter((rel) =>
      /^\.github\/workflows\/.+\.ya?ml$/.test(rel) ||
      /^\.gitlab-ci\.ya?ml$/.test(rel) ||
      /^\.circleci\//.test(rel) ||
      /^\.forgejo\/workflows\//.test(rel)
    )
    .slice(0, 20)
    .map((rel) => ({ path: rel, name: stripDocExtension(baseName(rel)) }));
}

async function readExistingDocs(
  repoPath: string,
  docsDir: string,
  files: string[],
): Promise<RepoProfile["docs"]> {
  const prefix = docsDir === "." ? "" : `${docsDir}/`;
  const configRel = docsDir === "." ? "docs.json" : `${docsDir}/docs.json`;
  const configPresent = await pathExists(joinPath(repoPath, configRel));

  const pages = files
    .filter((rel) => rel.startsWith(prefix))
    .filter((rel) => {
      const ext = extName(rel);
      return ext === "mdx" || ext === "md";
    })
    .map((rel) => stripDocExtension(rel.slice(prefix.length)))
    .sort();

  const legacyConfig = await pathExists(joinPath(repoPath, "mint.json"));

  return {
    dir: docsDir,
    exists: await pathExists(joinPath(repoPath, docsDir)),
    configPath: configRel,
    configPresent,
    legacyMintJson: legacyConfig,
    pages: pages.slice(0, 500),
  };
}

function detectLicense(files: string[]): string | null {
  const match = files.find((rel) =>
    /^(LICENSE|LICENCE|COPYING)(\.[A-Za-z]+)?$/i.test(baseName(rel)) &&
    !rel.includes("/")
  );
  return match ?? null;
}

function deriveDescription(
  manifests: PackageManifest[],
  readme: MarkdownDoc | undefined,
): string | null {
  const fromManifest = manifests.find((m) =>
    m.description !== null && m.description !== ""
  );
  if (fromManifest?.description != null) return fromManifest.description;
  return readme?.excerpt ?? null;
}

/**
 * Coarse project classification, used to pick which documentation groups the
 * plan emits. Deliberately conservative — "library" is the neutral fallback.
 */
function classifyKind(
  manifests: PackageManifest[],
  entrypoints: Entrypoint[],
  languages: LanguageStat[],
  files: string[],
): RepoProfile["kind"] {
  const hasBin = manifests.some((m) => m.binaries.length > 0);
  const shellHeavy = languages[0]?.language === "Shell";
  const hasService = files.some((f) =>
    /^(Dockerfile|docker-compose\.ya?ml|Procfile)$/.test(baseName(f))
  );
  const codeLanguages = languages.filter((l) =>
    !NON_CODE_LANGUAGES.has(l.language)
  );

  if (hasBin || entrypoints.length >= 2 && shellHeavy) return "cli";
  if (hasService) return "service";
  if (codeLanguages.length === 0) return "configuration";
  if (entrypoints.length >= 1 && shellHeavy) return "cli";
  return "library";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

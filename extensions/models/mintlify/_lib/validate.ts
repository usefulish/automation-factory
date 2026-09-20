/**
 * Validates a generated Mintlify documentation set.
 *
 * Two layers: the official `docs.json` JSON Schema (via ajv), and structural
 * checks the schema cannot express — that every navigation entry resolves to a
 * file, that no page is unreachable, that frontmatter is present, that internal
 * links and images resolve, and that no placeholder text survived authoring.
 *
 * @module
 */

import { Ajv } from "npm:ajv@8.18.0";
import type { ErrorObject, ValidateFunction } from "npm:ajv@8.18.0";
import {
  dirName,
  joinPath,
  pathExists,
  readTextIfExists,
  stripDocExtension,
} from "./util.ts";
import { listDocPages } from "./config.ts";
import type { IssueSeverity, ValidationIssue } from "./types.ts";

/** Placeholder markers that indicate unfinished authoring. */
const PLACEHOLDER_PATTERN =
  /\b(TODO|TBD|FIXME|XXX|Lorem ipsum|PLACEHOLDER|Coming soon|<!--\s*fill)\b/i;

/**
 * ajv compiles `pattern` keywords with the `u` flag, but the published Mintlify
 * schema contains patterns that are invalid under Unicode mode (e.g. `^phc\_`).
 * Dropping the flag keeps those patterns compilable without changing intent.
 *
 * The `code` property is ajv's standalone-codegen contract for a regex engine.
 */
const NON_UNICODE_REGEXP = Object.assign(
  (source: string, flags: string) => new RegExp(source, flags.replace("u", "")),
  { code: "new RegExp" },
);

/** Max issues of any one kind reported, to keep output actionable. */
const MAX_PER_KIND = 25;

/** The complete result of validating a documentation set. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly pageCount: number;
  readonly configPath: string;
  readonly schemaOrigin: string;
  readonly issues: ValidationIssue[];
  readonly checkedAt: string;
}

/** Options accepted by {@linkcode validateDocs}. */
export interface ValidateOptions {
  readonly repoPath: string;
  readonly docsDir: string;
  readonly configPath: string;
  readonly schema: Record<string, unknown>;
  readonly schemaOrigin: string;
  /** Treat missing page descriptions and orphan pages as errors. */
  readonly strict: boolean;
}

/**
 * Validate the documentation set rooted at `configPath`.
 *
 * @param opts Checkout layout plus the schema to validate the config against.
 * @returns Every finding, with counts and an overall pass flag.
 */
export async function validateDocs(
  opts: ValidateOptions,
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const configAbs = joinPath(opts.repoPath, opts.configPath);
  const raw = await readTextIfExists(configAbs);

  if (raw === null) {
    issues.push({
      severity: "error",
      kind: "missing-config",
      file: opts.configPath,
      message:
        `No Mintlify configuration at ${opts.configPath}. Mintlify will not build ` +
        `without it.`,
    });
    return summarise(issues, 0, opts);
  }

  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error("top level value is not a JSON object");
    }
    config = parsed as Record<string, unknown>;
  } catch (error) {
    issues.push({
      severity: "error",
      kind: "invalid-json",
      file: opts.configPath,
      message: `${opts.configPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return summarise(issues, 0, opts);
  }

  issues.push(...validateAgainstSchema(config, opts.schema, opts.configPath));

  const navPages = collectNavigationPages(config.navigation);
  const { pages: onDisk, truncated } = await listDocPages(
    opts.repoPath,
    opts.docsDir,
  );
  const onDiskSet = new Set(onDisk);

  if (truncated) {
    issues.push({
      severity: "warning",
      kind: "scan-truncated",
      file: null,
      message:
        `The documentation directory contains more files than this validator ` +
        `scans, so some pages were not checked.`,
    });
  }

  issues.push(...checkNavigationResolves(navPages, onDiskSet, opts));
  issues.push(...checkOrphans(navPages, onDisk, opts));
  issues.push(
    ...await checkPages(onDisk, onDiskSet, opts),
  );

  return summarise(issues, onDisk.length, opts);
}

/**
 * Validate the config against the Mintlify schema.
 *
 * The published schema is a nine-way `anyOf` over themes, so raw ajv output
 * reports every mismatch nine times over. The whole document is still compiled
 * — its branches use internal `$ref`s that only resolve against the full
 * schema — and errors attributable to a theme branch the config did not select
 * are dropped afterwards, leaving findings that point at the real problem.
 */
function validateAgainstSchema(
  config: Record<string, unknown>,
  schema: Record<string, unknown>,
  configPath: string,
): ValidationIssue[] {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    code: { regExp: NON_UNICODE_REGEXP },
  });

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    return [{
      severity: "warning",
      kind: "schema-unavailable",
      file: configPath,
      message:
        `Could not compile the Mintlify schema, so docs.json was not checked ` +
        `for schema conformance: ${
          error instanceof Error ? error.message : String(error)
        }`,
    }];
  }

  const themes = themeBranches(schema);
  const themeIndex = themes.indexOf(config.theme as string);

  if (themes.length > 0 && themeIndex === -1) {
    return [{
      severity: "error",
      kind: "schema",
      file: configPath,
      message: `"theme" must be one of: ${themes.join(", ")}`,
    }];
  }

  if (validate(config)) return [];

  // Prefixes belonging to the theme branches this config did not select.
  const foreignBranches = themes
    .map((_, index) => `#/anyOf/${index}/`)
    .filter((_, index) => index !== themeIndex);

  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  for (const error of (validate.errors ?? []) as ErrorObject[]) {
    // `anyOf`/`oneOf` wrappers restate what their branches already reported.
    if (error.keyword === "anyOf" || error.keyword === "oneOf") continue;
    if (foreignBranches.some((prefix) => error.schemaPath.startsWith(prefix))) {
      continue;
    }

    const where = error.instancePath === "" ? "(root)" : error.instancePath;
    const message = `${where}: ${error.message ?? "failed schema validation"}${
      formatParams(error)
    }`;
    if (seen.has(message)) continue;
    seen.add(message);
    issues.push({
      severity: "error",
      kind: "schema",
      file: configPath,
      message,
    });
    if (seen.size >= MAX_PER_KIND) break;
  }
  return issues;
}

function formatParams(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (Array.isArray(params.allowedValues)) {
    return ` (allowed: ${params.allowedValues.join(", ")})`;
  }
  if (typeof params.additionalProperty === "string") {
    return ` ("${params.additionalProperty}" is not a recognised key)`;
  }
  if (typeof params.missingProperty === "string") {
    return ` (missing "${params.missingProperty}")`;
  }
  return "";
}

/** The `theme` const of each top-level `anyOf` branch, in order. */
export function themeBranches(schema: Record<string, unknown>): string[] {
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf as Record<string, unknown>[]
    : null;
  if (branches === null) return [];

  const themes: string[] = [];
  for (const branch of branches) {
    const properties = branch.properties as Record<string, unknown> | undefined;
    const theme = properties?.theme as Record<string, unknown> | undefined;
    if (typeof theme?.const === "string") themes.push(theme.const);
  }
  return themes;
}

/**
 * Walk a Mintlify `navigation` value and collect every page path it references.
 *
 * Navigation nests arbitrarily (products → languages → versions → tabs →
 * anchors → dropdowns → groups → pages), and `pages` entries are either a page
 * path string or a nested group, so this recurses structurally rather than
 * assuming a shape.
 */
export function collectNavigationPages(navigation: unknown): string[] {
  const out: string[] = [];

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;

    const record = node as Record<string, unknown>;
    // External links and generated API pages are not local files.
    if (typeof record.href === "string") return;
    if ("openapi" in record || "asyncapi" in record || "graphql" in record) {
      if (!("pages" in record)) return;
    }
    for (const [key, value] of Object.entries(record)) {
      if (
        key === "pages" || key === "groups" || key === "tabs" ||
        key === "anchors" || key === "dropdowns" || key === "versions" ||
        key === "languages" || key === "products" || key === "menu"
      ) {
        visit(value);
      } else if (key === "root" && typeof value === "string") {
        out.push(value);
      }
    }
  };

  visit(navigation);
  return Array.from(new Set(out));
}

function checkNavigationResolves(
  navPages: string[],
  onDisk: Set<string>,
  opts: ValidateOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const page of navPages) {
    if (onDisk.has(page)) continue;
    issues.push({
      severity: "error",
      kind: "missing-page",
      file: opts.configPath,
      message:
        `Navigation references "${page}" but no ${page}.mdx or ${page}.md exists ` +
        `under ${opts.docsDir}/.`,
    });
    if (issues.length >= MAX_PER_KIND) break;
  }
  return issues;
}

function checkOrphans(
  navPages: string[],
  onDisk: string[],
  opts: ValidateOptions,
): ValidationIssue[] {
  const referenced = new Set(navPages);
  const issues: ValidationIssue[] = [];
  for (const page of onDisk) {
    if (referenced.has(page)) continue;
    issues.push({
      severity: opts.strict ? "error" : "warning",
      kind: "orphan-page",
      file: pageFile(opts.docsDir, page),
      message:
        `"${page}" exists but is not reachable from navigation — readers cannot ` +
        `find it.`,
    });
    if (issues.length >= MAX_PER_KIND) break;
  }
  return issues;
}

async function checkPages(
  onDisk: string[],
  onDiskSet: Set<string>,
  opts: ValidateOptions,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const counts = new Map<string, number>();

  const push = (
    severity: IssueSeverity,
    kind: string,
    file: string,
    message: string,
  ): void => {
    const n = counts.get(kind) ?? 0;
    if (n >= MAX_PER_KIND) return;
    counts.set(kind, n + 1);
    issues.push({ severity, kind, file, message });
  };

  for (const page of onDisk) {
    const rel = pageFile(opts.docsDir, page);
    const abs = joinPath(opts.repoPath, rel);
    const text = await readTextIfExists(abs);
    if (text === null) continue;

    const frontmatter = parseFrontmatter(text);
    if (frontmatter === null) {
      push(
        "error",
        "missing-frontmatter",
        rel,
        `No YAML frontmatter. Mintlify needs a leading "---" block with at ` +
          `least a title.`,
      );
    } else {
      if ((frontmatter.title ?? "") === "") {
        push("error", "missing-title", rel, `Frontmatter has no "title".`);
      }
      if ((frontmatter.description ?? "") === "") {
        push(
          opts.strict ? "error" : "warning",
          "missing-description",
          rel,
          `Frontmatter has no "description" — it drives search results and SEO.`,
        );
      }
    }

    const body = stripFrontmatter(text);
    if (body.trim().length < 80) {
      push(
        "error",
        "empty-page",
        rel,
        `Page body is ${body.trim().length} characters — effectively empty.`,
      );
    }

    const placeholder = body.match(PLACEHOLDER_PATTERN);
    if (placeholder !== null) {
      push(
        "error",
        "placeholder",
        rel,
        `Contains unfinished placeholder text ("${placeholder[0]}").`,
      );
    }

    for (const link of internalLinks(body)) {
      const target = resolveLink(link, page);
      // A directory link resolves to that directory's index page, the same way
      // Mintlify serves it.
      if (
        target === null || onDiskSet.has(target) ||
        onDiskSet.has(`${target}/index`)
      ) {
        continue;
      }
      push(
        "error",
        "broken-link",
        rel,
        `Link "${link}" does not resolve to a page in this docs set.`,
      );
    }

    for (const asset of localAssets(body)) {
      const assetAbs = asset.startsWith("/")
        ? joinPath(opts.repoPath, opts.docsDir, asset.slice(1))
        : joinPath(opts.repoPath, dirName(rel), asset);
      if (await pathExists(assetAbs)) continue;
      push("error", "missing-asset", rel, `Asset "${asset}" does not exist.`);
    }
  }

  return issues;
}

function pageFile(docsDir: string, page: string): string {
  return docsDir === "." ? `${page}.mdx` : joinPath(docsDir, `${page}.mdx`);
}

/** Parse the leading `---` YAML block. Only scalar keys are needed here. */
export function parseFrontmatter(
  text: string,
): Record<string, string> | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(text.indexOf("\n") + 1, end);

  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match === null) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4);
}

/** Markdown links that point inside the docs set (not http, mailto, or #). */
export function internalLinks(body: string): string[] {
  const out: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of body.matchAll(pattern)) {
    const href = match[1];
    if (/^(https?:|mailto:|tel:|#)/i.test(href)) continue;
    if (href.startsWith("<")) continue;
    out.push(href);
  }
  return Array.from(new Set(out));
}

/** Local image/asset references from markdown and JSX `src` attributes. */
export function localAssets(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    out.push(match[1]);
  }
  for (const match of body.matchAll(/\bsrc=["']([^"']+)["']/g)) {
    out.push(match[1]);
  }
  return Array.from(new Set(out)).filter((href) =>
    !/^(https?:|data:|mailto:)/i.test(href)
  );
}

/**
 * Resolve a link href to a navigation page path, or null when it is not a page
 * reference at all (a pure anchor, or an asset).
 *
 * The docs root — `/`, or a link that normalises to nothing — is the `index`
 * page, which is how Mintlify serves it.
 */
export function resolveLink(href: string, fromPage: string): string | null {
  const withoutAnchor = href.split("#")[0].split("?")[0];
  if (withoutAnchor === "") return null;
  if (withoutAnchor === "/") return "index";
  if (
    /\.(png|jpe?g|gif|svg|webp|pdf|mp4|json|ya?ml|txt)$/i.test(withoutAnchor)
  ) {
    return null;
  }

  const target = stripDocExtension(withoutAnchor);
  if (target.startsWith("/")) return target.slice(1);

  const base = fromPage.includes("/") ? dirName(fromPage) : ".";
  const segments = (base === "." ? [] : base.split("/")).concat(
    target.split("/"),
  );
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length === 0 ? "index" : stack.join("/");
}

function summarise(
  issues: ValidationIssue[],
  pageCount: number,
  opts: ValidateOptions,
): ValidationResult {
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.length - errorCount;
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    pageCount,
    configPath: opts.configPath,
    schemaOrigin: opts.schemaOrigin,
    issues,
    checkedAt: new Date().toISOString(),
  };
}

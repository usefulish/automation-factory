/**
 * Creation and reconciliation of Mintlify `docs.json`.
 *
 * Navigation is always regenerated from the pages that actually exist on disk,
 * so the config can never drift into referencing a page that was never written.
 * Everything a human may have customised (logo, favicon, footer, integrations,
 * colours, theme) is preserved across runs.
 *
 * @module
 */

import {
  extName,
  joinPath,
  readTextIfExists,
  stripDocExtension,
  walkFiles,
  writeTextFile,
} from "./util.ts";
import type { DocsPlan } from "./types.ts";

/** The canonical schema URL Mintlify expects in `$schema`. */
export const DOCS_SCHEMA_URL = "https://mintlify.com/docs.json";

/** Outcome of an {@linkcode ensureDocsConfig} run. */
export interface EnsureConfigResult {
  readonly configPath: string;
  readonly created: boolean;
  readonly changed: boolean;
  readonly pageCount: number;
  readonly groupCount: number;
  readonly orphansAdopted: string[];
  readonly plannedMissing: string[];
  readonly config: Record<string, unknown>;
}

/** Options accepted by {@linkcode ensureDocsConfig}. */
export interface EnsureConfigOptions {
  readonly repoPath: string;
  readonly plan: DocsPlan;
  /** Overwrite presentation fields even when the existing config sets them. */
  readonly force: boolean;
  readonly dryRun: boolean;
}

/**
 * Write (or update) `docs.json` so it is schema-complete and its navigation
 * matches the pages on disk.
 *
 * @param opts Checkout path, the plan that drove authoring, and write flags.
 * @returns What the config now contains and whether the file changed.
 */
export async function ensureDocsConfig(
  opts: EnsureConfigOptions,
): Promise<EnsureConfigResult> {
  const { repoPath, plan, force, dryRun } = opts;
  const configAbs = joinPath(repoPath, plan.configPath);
  const existingRaw = await readTextIfExists(configAbs);

  let existing: Record<string, unknown> = {};
  if (existingRaw !== null) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      if (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (error) {
      // Never silently overwrite a config a human may have hand-written — a
      // stray comma should be fixed, not destroyed.
      throw new Error(
        `${plan.configPath} exists but is not valid JSON, so it cannot be ` +
          `safely updated: ${
            error instanceof Error ? error.message : String(error)
          }. Fix or delete the file and re-run.`,
      );
    }
  }

  const { pages: onDisk } = await listDocPages(repoPath, plan.docsDir);
  const { groups, orphansAdopted, plannedMissing } = buildNavigation(
    plan,
    onDisk,
  );

  const config: Record<string, unknown> = { ...existing };
  setIfMissing(config, "$schema", DOCS_SCHEMA_URL, force);
  setIfMissing(config, "theme", plan.theme, force);
  setIfMissing(config, "name", plan.siteName, force);
  setIfMissing(config, "colors", { ...plan.colors }, force);
  if (typeof config.description !== "string" && plan.repo !== null) {
    config.description = `Documentation for ${plan.repo}.`;
  }
  config.navigation = { groups };

  const serialised = `${JSON.stringify(orderKeys(config), null, 2)}\n`;
  const changed = serialised !== existingRaw;

  if (!dryRun && changed) {
    await writeTextFile(configAbs, serialised);
  }

  return {
    configPath: plan.configPath,
    created: existingRaw === null,
    changed,
    pageCount: groups.reduce((n, g) => n + g.pages.length, 0),
    groupCount: groups.length,
    orphansAdopted,
    plannedMissing,
    config,
  };
}

/** How many files the docs directory walk will look at before giving up. */
export const DOC_PAGE_SCAN_LIMIT = 5000;

/**
 * Navigation page paths (extension-stripped) that exist under the docs dir.
 *
 * `truncated` is true when the walk hit its limit — validation reports that
 * rather than quietly passing a docs set it only partially examined.
 */
export async function listDocPages(
  repoPath: string,
  docsDir: string,
): Promise<{ pages: string[]; truncated: boolean }> {
  const root = docsDir === "." ? repoPath : joinPath(repoPath, docsDir);
  const files = await walkFiles(root, DOC_PAGE_SCAN_LIMIT);
  const pages = files
    .filter((rel) => {
      const ext = extName(rel);
      return ext === "mdx" || ext === "md";
    })
    .map(stripDocExtension)
    .sort();
  return { pages, truncated: files.length >= DOC_PAGE_SCAN_LIMIT };
}

interface NavigationGroup {
  group: string;
  pages: string[];
}

/**
 * Reconcile the planned group order against the pages present on disk.
 *
 * Planned pages keep their planned order. Pages the agent added that the plan
 * did not anticipate are adopted into the group implied by their directory, so
 * nothing written ends up unreachable.
 */
export function buildNavigation(
  plan: DocsPlan,
  onDisk: string[],
): {
  groups: NavigationGroup[];
  orphansAdopted: string[];
  plannedMissing: string[];
} {
  const available = new Set(onDisk);
  const claimed = new Set<string>();
  const groups: NavigationGroup[] = [];
  const plannedMissing: string[] = [];

  for (const planned of plan.groups) {
    const pages: string[] = [];
    for (const p of planned.pages) {
      if (available.has(p.path)) {
        pages.push(p.path);
        claimed.add(p.path);
      } else {
        plannedMissing.push(p.path);
      }
    }
    if (pages.length > 0) groups.push({ group: planned.group, pages });
  }

  // Anything on disk the plan did not name, grouped by its top directory.
  const orphansAdopted: string[] = [];
  const byDirectory = new Map<string, string[]>();
  for (const path of onDisk) {
    if (claimed.has(path)) continue;
    orphansAdopted.push(path);
    const dir = path.includes("/") ? path.slice(0, path.indexOf("/")) : "";
    const list = byDirectory.get(dir) ?? [];
    list.push(path);
    byDirectory.set(dir, list);
  }

  for (const [dir, pages] of Array.from(byDirectory.entries()).sort()) {
    const title = dir === "" ? "More" : titleCase(dir);
    const existing = groups.find((g) =>
      g.group.toLowerCase() === title.toLowerCase()
    );
    if (existing !== undefined) {
      existing.pages.push(...pages);
    } else {
      groups.push({ group: title, pages });
    }
  }

  // A root `index` page must lead the first group — it is the docs home page.
  if (groups.length > 0) {
    const home = groups.find((g) => g.pages.includes("index"));
    if (home !== undefined) {
      home.pages = ["index", ...home.pages.filter((p) => p !== "index")];
      groups.splice(groups.indexOf(home), 1);
      groups.unshift(home);
    }
  }

  return { groups, orphansAdopted, plannedMissing };
}

function setIfMissing(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  force: boolean,
): void {
  const current = target[key];
  const absent = current === undefined || current === null || current === "";
  if (absent || force) target[key] = value;
}

/** Stable, human-friendly key order — navigation last because it is longest. */
function orderKeys(config: Record<string, unknown>): Record<string, unknown> {
  const preferred = [
    "$schema",
    "theme",
    "name",
    "description",
    "colors",
    "logo",
    "favicon",
    "navbar",
    "navigation",
    "footer",
  ];
  const out: Record<string, unknown> = {};
  for (const key of preferred) {
    if (key in config) out[key] = config[key];
  }
  for (const key of Object.keys(config)) {
    if (!(key in out)) out[key] = config[key];
  }
  return out;
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter((w) => w !== "")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

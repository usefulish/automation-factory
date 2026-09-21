/**
 * Supplies the official Mintlify `docs.json` JSON Schema.
 *
 * Mintlify evolves the schema, so the live copy is preferred and cached on
 * disk; a vendored copy shipped with the extension is the offline fallback so
 * validation never silently degrades to "no schema".
 *
 * @module
 */

import { joinPath, readTextIfExists, writeTextFile } from "./util.ts";

/** Where the schema came from, reported in the validation output. */
export type SchemaOrigin = "remote" | "cache" | "bundled";

/** A loaded schema plus its provenance. */
export interface LoadedSchema {
  readonly schema: Record<string, unknown>;
  readonly origin: SchemaOrigin;
  readonly url: string;
  /** Non-fatal reason the preferred source was not used. */
  readonly note: string | null;
}

/** Options accepted by {@linkcode loadDocsSchema}. */
export interface LoadSchemaOptions {
  readonly url: string;
  readonly cachePath: string;
  readonly cacheTtlHours: number;
  /** Absolute path to the schema vendored with the extension. */
  readonly bundledPath: string;
  readonly offline: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Load the Mintlify config schema, preferring fresh cache, then network, then
 * the vendored copy.
 *
 * @param opts Source URL, cache location and TTL, and the bundled fallback.
 * @returns The parsed schema and where it came from.
 */
export async function loadDocsSchema(
  opts: LoadSchemaOptions,
): Promise<LoadedSchema> {
  const cached = await readFreshCache(opts.cachePath, opts.cacheTtlHours);
  if (cached !== null) {
    return { schema: cached, origin: "cache", url: opts.url, note: null };
  }

  let note: string | null = null;
  if (!opts.offline) {
    try {
      const response = await fetch(opts.url, { signal: opts.signal });
      if (response.ok) {
        const text = await response.text();
        const schema = JSON.parse(text) as Record<string, unknown>;
        await writeTextFile(opts.cachePath, text).catch(() => {});
        return { schema, origin: "remote", url: opts.url, note: null };
      }
      await response.body?.cancel();
      note = `Schema fetch returned ${response.status} ${response.statusText}`;
    } catch (error) {
      note = `Schema fetch failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  } else {
    note = "Offline mode requested";
  }

  // Fall back to a stale cache before the bundled copy — it is still newer.
  const stale = await readCache(opts.cachePath);
  if (stale !== null) {
    return {
      schema: stale,
      origin: "cache",
      url: opts.url,
      note: note === null ? null : `${note}; used stale cached schema`,
    };
  }

  const bundled = await readTextIfExists(opts.bundledPath);
  if (bundled === null) {
    throw new Error(
      `Unable to load the Mintlify docs.json schema: no network result, no ` +
        `cache at ${opts.cachePath}, and no bundled copy at ${opts.bundledPath}` +
        `${note === null ? "" : ` (${note})`}`,
    );
  }
  return {
    schema: JSON.parse(bundled) as Record<string, unknown>,
    origin: "bundled",
    url: opts.url,
    note: note === null ? null : `${note}; used bundled schema`,
  };
}

/** Default on-disk cache location for the fetched schema. */
export function defaultCachePath(repoDir: string): string {
  return joinPath(repoDir, ".swamp", "mintlify", "docs-schema.json");
}

async function readFreshCache(
  path: string,
  ttlHours: number,
): Promise<Record<string, unknown> | null> {
  if (ttlHours <= 0) return null;
  try {
    const info = await Deno.stat(path);
    const mtime = info.mtime?.getTime() ?? 0;
    const ageHours = (Date.now() - mtime) / 3_600_000;
    if (ageHours > ttlHours) return null;
  } catch {
    return null;
  }
  return await readCache(path);
}

async function readCache(
  path: string,
): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

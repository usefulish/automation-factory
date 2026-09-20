/**
 * Path, filesystem, and subprocess helpers shared by the Mintlify model methods.
 *
 * Deliberately dependency-free: the only npm packages this extension bundles are
 * zod and ajv, so everything here is hand-rolled against the Deno standard APIs.
 *
 * @module
 */

/** Result of running a subprocess. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Join path segments with `/`, collapsing duplicate separators. */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== "" && p !== ".")
    .join("/")
    .replace(/\/{2,}/g, "/");
  return joined === "" ? "." : joined;
}

/** The final segment of a path, with any trailing slash removed. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Everything before the final segment of a path, or "." when there is none. */
export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "." : trimmed.slice(0, idx);
}

/** Lowercased file extension without the dot, or "" when the file has none. */
export function extName(path: string): string {
  const base = baseName(path);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/** Drop a trailing `.md`/`.mdx` extension — Mintlify navigation omits it. */
export function stripDocExtension(path: string): string {
  return path.replace(/\.mdx?$/i, "");
}

/**
 * Turn arbitrary text into a lowercase, hyphen-separated slug safe for use as a
 * filename, a swamp data instance name, and a Mintlify navigation path segment.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug === "" ? "untitled" : slug;
}

/** True when the path exists and is readable. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the path exists and is a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await Deno.stat(path);
    return info.isDirectory;
  } catch {
    return false;
  }
}

/** Read a text file, returning null when it does not exist or cannot be read. */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/**
 * Read a text file but stop after `maxBytes`. Large files (lockfiles, vendored
 * assets) would otherwise blow up both memory and the agent prompt.
 */
export async function readTextCapped(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const info = await Deno.stat(path);
    if (!info.isFile) return null;
    if (info.size <= maxBytes) {
      return { text: await Deno.readTextFile(path), truncated: false };
    }
    const file = await Deno.open(path, { read: true });
    try {
      const buf = new Uint8Array(maxBytes);
      let filled = 0;
      while (filled < maxBytes) {
        const n = await file.read(buf.subarray(filled));
        if (n === null) break;
        filled += n;
      }
      const text = new TextDecoder(undefined, { fatal: false })
        .decode(buf.subarray(0, filled));
      return { text, truncated: true };
    } finally {
      file.close();
    }
  } catch {
    return null;
  }
}

/** Run a command, capturing stdout/stderr and enforcing a wall-clock timeout. */
export async function runCommand(
  binary: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    clearEnv?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<CommandResult> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = opts.timeoutMs !== undefined && opts.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs)
    : undefined;

  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const command = new Deno.Command(binary, {
      args,
      cwd: opts.cwd,
      env: opts.env,
      clearEnv: opts.clearEnv ?? false,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    const output = await command.output();
    return decodeOutput(output, timedOut);
  } catch (error) {
    if (timedOut) {
      return { code: 124, stdout: "", stderr: "timed out", timedOut: true };
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

function decodeOutput(
  output: Deno.CommandOutput,
  timedOut: boolean,
): CommandResult {
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    timedOut,
  };
}

/** Run `git` inside `repoPath`. Never throws — inspect `code` instead. */
export async function runGit(
  repoPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  try {
    return await runCommand("git", args, {
      cwd: repoPath,
      timeoutMs: 60_000,
      signal,
    });
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
}

/** Directory names that never contain documentable source. */
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "vendor",
  ".terraform",
  ".swamp",
  ".cache",
  ".idea",
  ".vscode",
  "coverage",
]);

/**
 * List repository files as paths relative to `repoPath`.
 *
 * Prefers `git ls-files` so .gitignore is honoured for free; falls back to a
 * filtered filesystem walk when the path is not a git checkout.
 */
export async function listRepoFiles(
  repoPath: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const tracked = await runGit(
    repoPath,
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    signal,
  );
  if (tracked.code === 0) {
    const files = tracked.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .filter((line) => !line.split("/").some((seg) => SKIP_DIRS.has(seg)));
    if (files.length > 0) return files.slice(0, limit);
  }
  return await walkFiles(repoPath, limit);
}

/** Recursive filesystem walk returning paths relative to `root`. */
export async function walkFiles(
  root: string,
  limit: number,
): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [""];

  while (queue.length > 0 && out.length < limit) {
    const rel = queue.shift() as string;
    const abs = rel === "" ? root : joinPath(root, rel);
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(abs)) entries.push(entry);
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.isSymlink) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(childRel);
      } else if (entry.isFile) {
        out.push(childRel);
      }
    }
  }
  return out;
}

/** Stable byte size of a file, or 0 when it cannot be stat'd. */
export async function fileSize(path: string): Promise<number> {
  try {
    const info = await Deno.stat(path);
    return info.isFile ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Ensure a directory exists, creating parents as needed. */
export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

/** Write text to a path, creating parent directories first. */
export async function writeTextFile(
  path: string,
  content: string,
): Promise<void> {
  const dir = dirName(path);
  if (dir !== "." && dir !== "") await ensureDir(dir);
  await Deno.writeTextFile(path, content);
}

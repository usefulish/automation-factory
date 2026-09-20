/**
 * Invokes a local coding-agent CLI to author the documentation pages.
 *
 * The agent runs with the narrowest permissions that still let it write docs:
 * `--restricted` removes the command-execution tools entirely, the tool
 * allowlist is explicit, `--add-dir` scopes filesystem access to the checkout,
 * and anything that would otherwise prompt is denied. The permission-bypass
 * flag is never used.
 *
 * @module
 */

import { extName, joinPath, runCommand, walkFiles } from "./util.ts";

/** A file the agent created or modified under the docs directory. */
export interface ChangedFile {
  readonly path: string;
  readonly change: "added" | "modified";
  readonly bytes: number;
}

/** Outcome of an authoring run. */
export interface AuthorResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly provider: string;
  readonly model: string | null;
  readonly sessionId: string | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly summary: string;
  readonly changedFiles: ChangedFile[];
  readonly permissionDenials: number;
  /** Full stdout plus stderr, for the run log file. */
  readonly log: string;
}

/** Tools the agent is allowed to use. Deliberately excludes command execution. */
export const AUTHOR_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "TodoWrite",
];

/** Options accepted by {@linkcode runAuthoringAgent}. */
export interface AuthorOptions {
  readonly repoPath: string;
  readonly docsDir: string;
  readonly prompt: string;
  readonly cliPath: string;
  readonly model: string | null;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Run the authoring agent over a checkout and report what changed.
 *
 * @param opts Checkout path, prompt, and CLI settings.
 * @returns Exit status, agent metadata, and the docs files that changed.
 */
export async function runAuthoringAgent(
  opts: AuthorOptions,
): Promise<AuthorResult> {
  const docsRoot = opts.docsDir === "."
    ? opts.repoPath
    : joinPath(opts.repoPath, opts.docsDir);

  const before = await snapshotDocs(docsRoot);
  const startedAt = Date.now();

  const args = [
    "--print",
    opts.prompt,
    "--output-format",
    "json",
    // Removes Bash/PowerShell/REPL — the agent only needs to read and write.
    "--restricted",
    "--permission-mode",
    "acceptEdits",
    // Nothing is around to answer a prompt; anything unlisted is denied.
    "--permission-prompts",
    "none",
    "--add-dir",
    opts.repoPath,
    "--allowedTools",
    ...AUTHOR_ALLOWED_TOOLS,
  ];
  if (opts.model !== null) args.push("--model", opts.model);

  const result = await runCommand(opts.cliPath, args, {
    cwd: opts.repoPath,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });

  const durationMs = Date.now() - startedAt;
  const after = await snapshotDocs(docsRoot);
  const meta = parseAgentJson(result.stdout);

  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs,
    provider: "claude",
    model: meta.model ?? opts.model,
    sessionId: meta.sessionId,
    costUsd: meta.costUsd,
    numTurns: meta.numTurns,
    summary: meta.summary ?? truncate(result.stdout.trim(), 2000),
    changedFiles: diffSnapshots(before, after, opts.docsDir),
    permissionDenials: meta.permissionDenials,
    log: [
      `$ ${opts.cliPath} --print <prompt> --output-format json --restricted ` +
      `--permission-mode acceptEdits --permission-prompts none --add-dir ` +
      `${opts.repoPath} --allowedTools ${AUTHOR_ALLOWED_TOOLS.join(" ")}` +
      `${opts.model === null ? "" : ` --model ${opts.model}`}`,
      `# exit=${result.code} timedOut=${result.timedOut} durationMs=${durationMs}`,
      "",
      "--- stdout ---",
      result.stdout,
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  };
}

interface AgentMeta {
  readonly model: string | null;
  readonly sessionId: string | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly summary: string | null;
  readonly permissionDenials: number;
}

/** Parse the agent CLI's `--output-format json` envelope, tolerantly. */
export function parseAgentJson(stdout: string): AgentMeta {
  const empty: AgentMeta = {
    model: null,
    sessionId: null,
    costUsd: null,
    numTurns: null,
    summary: null,
    permissionDenials: 0,
  };

  const trimmed = stdout.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const modelUsage = parsed.modelUsage;
  const model = typeof modelUsage === "object" && modelUsage !== null
    ? Object.keys(modelUsage as Record<string, unknown>)[0] ?? null
    : null;

  return {
    model,
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    costUsd: typeof parsed.total_cost_usd === "number"
      ? parsed.total_cost_usd
      : null,
    numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : null,
    summary: typeof parsed.result === "string" ? parsed.result : null,
    permissionDenials: Array.isArray(parsed.permission_denials)
      ? parsed.permission_denials.length
      : 0,
  };
}

/** Map of docs-relative path → `size:mtime`, used to detect writes. */
async function snapshotDocs(docsRoot: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let files: string[];
  try {
    files = await walkFiles(docsRoot, 4000);
  } catch {
    return out;
  }
  for (const rel of files) {
    const ext = extName(rel);
    if (ext !== "mdx" && ext !== "md" && ext !== "json") continue;
    try {
      const info = await Deno.stat(joinPath(docsRoot, rel));
      out.set(rel, `${info.size}:${info.mtime?.getTime() ?? 0}`);
    } catch {
      // Raced with the agent; treated as absent.
    }
  }
  return out;
}

function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
  docsDir: string,
): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const [rel, stamp] of after) {
    const previous = before.get(rel);
    if (previous === stamp) continue;
    out.push({
      path: docsDir === "." ? rel : joinPath(docsDir, rel),
      change: previous === undefined ? "added" : "modified",
      bytes: Number(stamp.split(":")[0]),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

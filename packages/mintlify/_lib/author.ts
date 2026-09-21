/**
 * Invokes a local coding-agent CLI to author the documentation pages.
 *
 * Provider-specific command lines and output formats are isolated here so the
 * surrounding inspect/plan/configure/validate pipeline stays provider-neutral.
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

/** Authoring providers with a supported non-interactive CLI contract. */
export type AuthorProvider = "claude" | "codex";

/** A provider-specific executable invocation. */
export interface AuthorInvocation {
  readonly cliPath: string;
  readonly args: string[];
  /** Human-readable command with the (potentially large) prompt redacted. */
  readonly display: string;
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
  readonly provider: AuthorProvider;
  /** Executable override. Empty/null uses the provider default. */
  readonly cliPath: string | null;
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
  const invocation = buildAuthorInvocation(opts);

  const result = await runCommand(invocation.cliPath, invocation.args, {
    cwd: opts.repoPath,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });

  const durationMs = Date.now() - startedAt;
  const after = await snapshotDocs(docsRoot);
  const meta = parseAgentOutput(opts.provider, result.stdout);

  return {
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs,
    provider: opts.provider,
    model: meta.model ?? opts.model,
    sessionId: meta.sessionId,
    costUsd: meta.costUsd,
    numTurns: meta.numTurns,
    summary: meta.summary ?? truncate(result.stdout.trim(), 2000),
    changedFiles: diffSnapshots(before, after, opts.docsDir),
    permissionDenials: meta.permissionDenials,
    log: [
      `$ ${invocation.display}`,
      `# exit=${result.code} timedOut=${result.timedOut} durationMs=${durationMs}`,
      "",
      "--- stdout ---",
      result.stdout,
      "--- stderr ---",
      result.stderr,
    ].join("\n"),
  };
}

/** Resolve a provider's executable, preserving explicit path overrides. */
export function resolveAuthorCliPath(
  provider: AuthorProvider,
  cliPath: string | null,
): string {
  const override = cliPath?.trim();
  return override === undefined || override === "" ? provider : override;
}

/** Build the provider-specific command while keeping orchestration generic. */
export function buildAuthorInvocation(
  opts: Pick<
    AuthorOptions,
    "provider" | "cliPath" | "model" | "prompt" | "repoPath"
  >,
): AuthorInvocation {
  const cliPath = resolveAuthorCliPath(opts.provider, opts.cliPath);

  if (opts.provider === "codex") {
    const args = [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ephemeral",
      "--json",
    ];
    if (opts.model !== null) args.push("--model", opts.model);
    args.push(opts.prompt);
    return {
      cliPath,
      args,
      display: [
        cliPath,
        "exec --sandbox workspace-write --ephemeral --json",
        opts.model === null ? "" : `--model ${opts.model}`,
        "<prompt>",
      ].filter((part) => part !== "").join(" "),
    };
  }

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
  return {
    cliPath,
    args,
    display: [
      cliPath,
      "--print <prompt> --output-format json --restricted",
      "--permission-mode acceptEdits --permission-prompts none",
      `--add-dir ${opts.repoPath}`,
      `--allowedTools ${AUTHOR_ALLOWED_TOOLS.join(" ")}`,
      opts.model === null ? "" : `--model ${opts.model}`,
    ].filter((part) => part !== "").join(" "),
  };
}

export interface AgentMeta {
  readonly model: string | null;
  readonly sessionId: string | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly summary: string | null;
  readonly permissionDenials: number;
}

const EMPTY_AGENT_META: AgentMeta = {
  model: null,
  sessionId: null,
  costUsd: null,
  numTurns: null,
  summary: null,
  permissionDenials: 0,
};

/** Parse provider output without leaking its wire format into the model. */
export function parseAgentOutput(
  provider: AuthorProvider,
  stdout: string,
): AgentMeta {
  return provider === "codex"
    ? parseCodexAgentJsonl(stdout)
    : parseClaudeAgentJson(stdout);
}

/** Parse Claude's `--output-format json` envelope, tolerantly. */
export function parseClaudeAgentJson(stdout: string): AgentMeta {
  const empty = { ...EMPTY_AGENT_META };

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

/** Backwards-compatible name for callers that consumed the Claude parser. */
export const parseAgentJson = parseClaudeAgentJson;

/** Parse the JSONL event stream emitted by `codex exec --json`. */
export function parseCodexAgentJsonl(stdout: string): AgentMeta {
  let sessionId: string | null = null;
  let summary: string | null = null;
  let numTurns = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (
      event.type === "thread.started" && typeof event.thread_id === "string"
    ) {
      sessionId = event.thread_id;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      numTurns += 1;
    }
    if (event.type === "item.completed") {
      const item = event.item;
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (
          record.type === "agent_message" && typeof record.text === "string"
        ) {
          summary = record.text;
        }
      }
    }
  }

  return {
    ...EMPTY_AGENT_META,
    sessionId,
    summary,
    numTurns: numTurns === 0 ? null : numTurns,
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

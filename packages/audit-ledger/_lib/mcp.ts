/**
 * Minimal MCP stdio client for the knowfleet server.
 *
 * Every ledger MUTATION goes through here rather than through SQLite,
 * because the invariants that make the ledger trustworthy live in the
 * server, not the schema: audit_run_create snapshots each target's version
 * hash at creation time, audit_verdict_add refuses a completed run,
 * investigation_start refuses a verdict that is not machine-revisable, and
 * completion is idempotent. Writing SQL directly would bypass all four —
 * and the audit-loop contract forbids it outright.
 *
 * The client speaks just enough JSON-RPC 2.0 to initialize, call a tool,
 * and shut the server down again. One process per call batch; the server is
 * stdio and cheap to spawn, exactly as every agent profile uses it.
 *
 * @module
 */

/** The knowfleet MCP entrypoint every profile launches. */
export const DEFAULT_SERVER =
  "/Users/guru/Code/deployed/knowfleet/src/index.js";

export interface McpOptions {
  nodePath: string;
  serverPath: string;
  dbPath: string;
  /** Provenance stamped on writes; the orchestrator is not a profile. */
  createdBy: string;
  profile: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface RpcResponse {
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/**
 * A single knowfleet MCP session. Open it, make the calls the pass needs,
 * then close it — the process lives exactly as long as the session.
 */
export class KnowfleetMcp {
  #proc: Deno.ChildProcess | null = null;
  #stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #buf = "";
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #next = 1;
  readonly #opts: McpOptions;

  constructor(opts: McpOptions) {
    this.#opts = opts;
  }

  /** Spawn the server and complete the MCP handshake. */
  async open(): Promise<void> {
    const o = this.#opts;
    this.#proc = new Deno.Command(o.nodePath, {
      args: [
        o.serverPath,
        `--db=${o.dbPath}`,
        `--created-by=${o.createdBy}`,
      ],
      env: {
        PATH: `/opt/homebrew/bin:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        HOME: Deno.env.get("HOME") ?? "/Users/guru",
        KNOWFLEET_PROFILE: o.profile,
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#stdin = this.#proc.stdin.getWriter();
    this.#reader = this.#proc.stdout.getReader();

    await this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "swamp-audit-ledger", version: "1" },
    });
    await this.#notify("notifications/initialized", {});
  }

  /** Call one knowfleet tool and return its parsed JSON payload. */
  async call<T = unknown>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.#request("tools/call", {
      name: tool,
      arguments: args,
    });
    const text = res.result?.content?.map((c) => c.text ?? "").join("") ?? "";
    if (res.result?.isError) {
      throw new Error(`knowfleet ${tool} failed: ${text || "unknown error"}`);
    }
    if (text.trim() === "") return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Some tools answer in prose; hand it back rather than pretending.
      return text as unknown as T;
    }
  }

  /** Shut the server down. Safe to call twice. */
  async close(): Promise<void> {
    try {
      await this.#stdin?.close();
    } catch { /* already closed */ }
    this.#stdin = null;
    try {
      this.#reader?.releaseLock();
    } catch { /* not held */ }
    this.#reader = null;
    if (this.#proc) {
      const p = this.#proc;
      this.#proc = null;
      try {
        await Promise.race([
          p.status,
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
      } finally {
        try {
          p.kill("SIGTERM");
        } catch { /* already exited */ }
        // Drain so the child's pipes never leak into the swamp run.
        try {
          await p.stderr.cancel();
        } catch { /* already drained */ }
        try {
          await p.stdout.cancel();
        } catch { /* already drained */ }
      }
    }
  }

  async #notify(method: string, params: unknown): Promise<void> {
    await this.#write({ jsonrpc: "2.0", method, params });
  }

  async #request(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.#next++;
    await this.#write({ jsonrpc: "2.0", id, method, params });
    const res = await this.#readUntil(id);
    if (res.error) {
      throw new Error(`knowfleet ${method}: ${res.error.message}`);
    }
    return res;
  }

  async #write(msg: unknown): Promise<void> {
    if (!this.#stdin) throw new Error("knowfleet MCP session is not open");
    await this.#stdin.write(
      new TextEncoder().encode(JSON.stringify(msg) + "\n"),
    );
  }

  /** Read newline-delimited JSON until the response with this id arrives. */
  async #readUntil(id: number): Promise<RpcResponse> {
    const deadline = Date.now() + this.#opts.timeoutMs;
    while (true) {
      const nl = this.#buf.indexOf("\n");
      if (nl >= 0) {
        const line = this.#buf.slice(0, nl).trim();
        this.#buf = this.#buf.slice(nl + 1);
        if (line !== "") {
          let msg: RpcResponse;
          try {
            msg = JSON.parse(line) as RpcResponse;
          } catch {
            continue; // server chatter that is not JSON-RPC
          }
          if (msg.id === id) return msg;
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `knowfleet MCP timed out after ${this.#opts.timeoutMs}ms ` +
            `waiting for response ${id}`,
        );
      }
      if (this.#opts.signal?.aborted) {
        throw new Error("knowfleet MCP call aborted");
      }
      if (!this.#reader) throw new Error("knowfleet MCP session is not open");
      const { value, done } = await this.#reader.read();
      if (done) {
        throw new Error(
          "knowfleet MCP server closed stdout before answering " +
            `request ${id}`,
        );
      }
      this.#buf += new TextDecoder().decode(value);
    }
  }
}

/** Open a session, run `fn`, and always close the server. */
export async function withKnowfleet<T>(
  opts: McpOptions,
  fn: (mcp: KnowfleetMcp) => Promise<T>,
): Promise<T> {
  const mcp = new KnowfleetMcp(opts);
  await mcp.open();
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

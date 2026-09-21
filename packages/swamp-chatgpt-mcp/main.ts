// swamp-chatgpt-mcp
//
// A thin MCP stdio server that exposes Swamp workflow operations to ChatGPT over
// the EXISTING authenticated MCP/Connector tunnel (knowfleet-chatgpt-tunnel),
// avoiding any public REST ingress. It is registered as a second
// `mcp.commands` channel ("swamp") alongside the knowfleet server.
//
// Trust model: the adapter authenticates to `swamp serve` as a FIXED local
// `user:chatgpt` principal (token read from a local file). Swamp's grant model
// is the sole authorization authority — the adapter performs no authz of its
// own and holds no credentials besides that one token. ChatGPT therefore always
// arrives at Swamp as user:chatgpt, scoped to read,run on promo-model-checker.
//
// This is a transport/schema adaptation only. Do NOT add a second permission
// system here; if a workflow should be reachable, add a Swamp grant.

const SWAMP_SERVE_URL = Deno.env.get("SWAMP_SERVE_URL") ?? "ws://127.0.0.1:9090";
const TOKEN_FILE =
  Deno.env.get("SWAMP_CHATGPT_TOKEN_FILE") ??
  "/Users/guru/.config/automation-factory/chatgpt-token.txt";
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("REQUEST_TIMEOUT_MS") ?? "120000");

// --- token (fixed local identity) -------------------------------------------

let CHATGPT_TOKEN = "";
try {
  CHATGPT_TOKEN = (await Deno.readTextFile(TOKEN_FILE)).trim();
} catch (err) {
  // Log to stderr only — stdout is the MCP channel and must stay clean.
  console.error(
    `swamp-chatgpt-mcp: cannot read user:chatgpt token from ${TOKEN_FILE}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

// --- swamp serve client (reuses the ?token= WebSocket pattern) --------------

interface SwampError {
  code: string;
  message: string;
  details?: unknown;
}

interface SwampCallResult {
  ok: boolean;
  events: unknown[];
  responses: unknown[];
  runId?: string;
  error?: SwampError;
}

/**
 * Opens a WebSocket to `swamp serve`, authenticating with the token via the
 * `?token=` query parameter (NOT the `bearer.<token>` subprotocol — Swamp
 * secrets can contain + / =, outside the RFC 6455 subprotocol charset, which
 * makes clients like Deno reject the handshake). Sends one request frame and
 * collects the streamed response until a terminal `done` or `error` frame.
 */
function callSwamp(
  token: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<SwampCallResult> {
  return new Promise<SwampCallResult>((resolve) => {
    const id = crypto.randomUUID();
    const result: SwampCallResult = { ok: false, events: [], responses: [] };
    let settled = false;

    let ws: WebSocket;
    try {
      const u = new URL(SWAMP_SERVE_URL);
      u.searchParams.set("token", token);
      ws = new WebSocket(u.toString());
    } catch (err) {
      result.error = {
        code: "upstream_unreachable",
        message: `Failed to open connection to ${SWAMP_SERVE_URL}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
      resolve(result);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch { /* ignore */ }
      result.error = {
        code: "upstream_timeout",
        message: `Upstream Swamp did not finish within ${REQUEST_TIMEOUT_MS}ms`,
      };
      resolve(result);
    }, REQUEST_TIMEOUT_MS);

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.error = {
        code: "upstream_error",
        message: `WebSocket error talking to ${SWAMP_SERVE_URL}`,
      };
      resolve(result);
    };

    ws.onopen = () => {
      const frame = payload === undefined ? { type, id } : { type, id, payload };
      ws.send(JSON.stringify(frame));
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg["id"] !== id) return;

      const mtype = msg["type"];
      if (mtype === "event") {
        const event = msg["event"] as Record<string, unknown> | undefined;
        if (event && typeof event === "object") {
          result.events.push(event);
          if (typeof event["runId"] === "string") {
            result.runId = event["runId"] as string;
          }
        }
      } else if (mtype === "server.version") {
        // connection-level handshake frame; ignore
      } else if (mtype === "error") {
        settled = true;
        clearTimeout(timer);
        result.error = msg["error"] as SwampError;
        try {
          ws.close();
        } catch { /* ignore */ }
        resolve(result);
      } else if (mtype === "done") {
        settled = true;
        clearTimeout(timer);
        result.ok = true;
        try {
          ws.close();
        } catch { /* ignore */ }
        resolve(result);
      } else {
        // Response payload frame (workflow.search, workflow.run.search, ...).
        // Non-run calls have NO terminal `done` frame — the single response
        // frame IS completion, so resolve now.
        result.responses.push(msg);
        settled = true;
        clearTimeout(timer);
        result.ok = true;
        try {
          ws.close();
        } catch { /* ignore */ }
        resolve(result);
      }
    };

    ws.onclose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok && !result.error) {
        result.error = {
          code: "upstream_closed",
          message: "Upstream connection closed before completion",
        };
      }
      resolve(result);
    };
  });
}

/** Safe nested getter through `unknown`. */
function dig<T = unknown>(root: unknown, ...keys: string[]): T | undefined {
  let cur: unknown = root;
  for (const k of keys) {
    if (cur !== null && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur as T;
}

// --- MCP plumbing (manual JSON-RPC 2.0 over newline-delimited stdio) --------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(msg: JsonRpcResponse | Record<string, unknown>): void {
  // stdout is the MCP channel — write only valid JSON-RPC, one message per line.
  Deno.stdout.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
}

const TOOLS = [
  {
    name: "list_workflows",
    description:
      "List Swamp workflows the caller is authorized to read. Scoped server-side by the user:chatgpt grant, so only approved workflows are returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional name/keyword filter." },
      },
      required: [],
    },
  },
  {
    name: "run_workflow",
    description:
      "Run a Swamp workflow by name. Requires the run grant on that workflow. Returns the run id and the completion event.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name or id." },
        inputs: {
          type: "object",
          description: "Optional workflow inputs keyed by name.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "get_run",
    description: "Fetch a past workflow run by its id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Run id." } },
      required: ["id"],
    },
  },
];

interface ToolResult {
  text: string;
  isError: boolean;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!CHATGPT_TOKEN) {
    return {
      isError: true,
      text: JSON.stringify({
        error: { code: "no_token", message: "user:chatgpt token unavailable to the adapter" },
      }),
    };
  }
  try {
    if (name === "list_workflows") {
      const call = await callSwamp(CHATGPT_TOKEN, "workflow.search", {
        query: typeof args["query"] === "string" ? args["query"] : undefined,
      });
      if (!call.ok || call.error) {
        return { isError: true, text: JSON.stringify({ error: call.error }) };
      }
      const payload = (call.responses[0] ?? {}) as Record<string, unknown>;
      const results = dig<unknown[]>(payload, "payload", "data", "results") ?? [];
      return { isError: false, text: JSON.stringify({ workflows: results }) };
    }
    if (name === "run_workflow") {
      const wfName = args["name"];
      if (typeof wfName !== "string" || wfName.length === 0) {
        return { isError: true, text: JSON.stringify({ error: { code: "bad_args", message: "name required" } }) };
      }
      const call = await callSwamp(CHATGPT_TOKEN, "workflow.run", {
        workflowIdOrName: wfName,
        inputs: (args["inputs"] as Record<string, unknown>) ?? undefined,
      });
      if (!call.ok || call.error) {
        return { isError: true, text: JSON.stringify({ error: call.error }) };
      }
      const last = call.events[call.events.length - 1] as Record<string, unknown> | undefined;
      return {
        isError: false,
        text: JSON.stringify({
          runId: call.runId,
          status: "completed",
          result: last && last["kind"] === "completed" ? last : undefined,
          events: call.events,
        }),
      };
    }
    if (name === "get_run") {
      const id = args["id"];
      if (typeof id !== "string" || id.length === 0) {
        return { isError: true, text: JSON.stringify({ error: { code: "bad_args", message: "id required" } }) };
      }
      const call = await callSwamp(CHATGPT_TOKEN, "workflow.run.search", {
        query: id,
        limit: 1,
      });
      if (!call.ok || call.error) {
        return { isError: true, text: JSON.stringify({ error: call.error }) };
      }
      const payload = (call.responses[0] ?? {}) as Record<string, unknown>;
      const results = dig<unknown[]>(payload, "payload", "data", "results") ?? [];
      return { isError: false, text: JSON.stringify({ runId: id, runs: results }) };
    }
    return { isError: true, text: JSON.stringify({ error: { code: "unknown_tool", message: name } }) };
  } catch (err) {
    return {
      isError: true,
      text: JSON.stringify({
        error: { code: "adapter_error", message: err instanceof Error ? err.message : String(err) },
      }),
    };
  }
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id;
  switch (req.method) {
    case "initialize": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "swamp-chatgpt-mcp", version: "0.1.0" },
        },
      });
      return;
    }
    case "notifications/initialized":
    case "ping":
      // No response for notifications; ping gets an empty result if it has an id.
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list": {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    case "tools/call": {
      const params = req.params ?? {};
      const name = params["name"] as string;
      const args = (params["arguments"] as Record<string, unknown>) ?? {};
      const r = await callTool(name, args);
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: r.text }], isError: r.isError },
      });
      return;
    }
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } });
      }
      return;
  }
}

// --- stdin loop --------------------------------------------------------------

console.error(`swamp-chatgpt-mcp: starting -> ${SWAMP_SERVE_URL} as user:chatgpt`);

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      await handleRequest(req);
    } catch (err) {
      console.error(`swamp-chatgpt-mcp: bad stdin frame: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

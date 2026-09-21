// swamp-chatgpt-gateway
//
// A thin REST/OpenAPI adapter that lets a ChatGPT GPT Action enumerate and run
// access-approved Swamp workflows without speaking Swamp's native WebSocket
// protocol. Each request opens a short-lived WebSocket to `swamp serve`,
// forwards the caller's bearer token as the `bearer.<token>` subprotocol, and
// translates the streamed `event`/`done`/`error` frames back into JSON.
//
// Access control is delegated entirely to Swamp: the gateway holds no
// credentials of its own. The bearer token presented by the GPT Action IS the
// Swamp server token (`<name>.<secret>`), and Swamp's grant model scopes what
// the caller may `read`/`run`. "List approved workflows" is therefore free:
// `workflow.search` is filtered server-side by the token's principal grants.

const SWAMP_SERVE_URL = Deno.env.get("SWAMP_SERVE_URL") ?? "ws://127.0.0.1:9090";
const PORT = Number(Deno.env.get("PORT") ?? "8787");
const REQUEST_TIMEOUT_MS = Number(Deno.env.get("REQUEST_TIMEOUT_MS") ?? "120000");

interface SwampError {
  code: string;
  message: string;
  details?: unknown;
}

interface SwampCallResult {
  ok: boolean;
  /** Every `event` frame received, in order (workflow.run streams these). */
  events: unknown[];
  /** Response payload frames for non-streaming calls (search, history). */
  responses: unknown[];
  /** The canonical run id, taken from the last event that carried one. */
  runId?: string;
  error?: SwampError;
}

/**
 * Opens a WebSocket to `swamp serve`, authenticating with the caller's token
 * via the `bearer.<token>` subprotocol, sends one request frame, and collects
 * the streamed response until a terminal `done` or `error` frame arrives.
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
      ws = new WebSocket(SWAMP_SERVE_URL, [`bearer.${token}`]);
    } catch (err) {
      result.error = {
        code: "gateway_upstream_unreachable",
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
        code: "gateway_upstream_timeout",
        message: `Upstream Swamp did not finish within ${REQUEST_TIMEOUT_MS}ms`,
      };
      resolve(result);
    }, REQUEST_TIMEOUT_MS);

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.error = {
        code: "gateway_upstream_error",
        message: `WebSocket error talking to ${SWAMP_SERVE_URL}`,
      };
      resolve(result);
    };

    ws.onopen = () => {
      const frame = payload === undefined
        ? { type, id }
        : { type, id, payload };
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
        // connection-level handshake frame; not a response, ignore
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
        // Response payload frame (workflow.search, workflow.run.search,
        // workflow.history.get, ...). Non-run calls have NO terminal `done`
        // frame — the single response frame IS the completion, so resolve now.
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
      // Connection dropped without a terminal frame: treat as incomplete.
      if (!result.ok && !result.error) {
        result.error = {
          code: "gateway_upstream_closed",
          message: "Upstream connection closed before completion",
        };
      }
      resolve(result);
    };
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Safe nested getter through `unknown` (no implicit-any on `unknown`). */
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

function errorResponse(err: SwampError): Response {
  const status = err.code === "not_found" ? 404 : 502;
  return jsonResponse({ error: err }, status);
}

function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h && h.slice(0, 7).toLowerCase() === "bearer ") {
    const t = h.slice(7).trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/healthz") {
    return jsonResponse({ status: "ok", upstream: SWAMP_SERVE_URL });
  }

  if (path === "/openapi.json") {
    try {
      const spec = await Deno.readTextFile(
        new URL("./openapi.json", import.meta.url),
      );
      return new Response(spec, { headers: { "content-type": "application/json" } });
    } catch {
      return jsonResponse({ error: { code: "no_spec", message: "openapi.json missing" } }, 404);
    }
  }

  const token = extractBearer(req);
  if (!token) {
    return jsonResponse(
      { error: { code: "unauthorized", message: "Missing Authorization: Bearer <swamp-token>" } },
      401,
    );
  }

  // GET /v1/workflows  ->  workflow.search (server-scoped to approved)
  if (path === "/v1/workflows" && req.method === "GET") {
    const call = await callSwamp(token, "workflow.search", {
      query: url.searchParams.get("query") ?? undefined,
    });
    if (!call.ok || call.error) {
      return errorResponse(call.error ?? { code: "unknown", message: "upstream error" });
    }
    const payload = (call.responses[0] ?? {}) as Record<string, unknown>;
    const results = dig<unknown[]>(payload, "payload", "data", "results") ?? [];
    return jsonResponse({ workflows: results });
  }

  // POST /v1/workflows/{name}/runs  ->  workflow.run (synchronous)
  let m = path.match(/^\/v1\/workflows\/([^/]+)\/runs$/);
  if (m && req.method === "POST") {
    const name = decodeURIComponent(m[1]);
    let inputs: Record<string, unknown> | undefined;
    if (req.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = await req.json();
        inputs = body?.inputs;
      } catch {
        return jsonResponse({ error: { code: "bad_request", message: "Invalid JSON body" } }, 400);
      }
    }
    const call = await callSwamp(token, "workflow.run", {
      workflowIdOrName: name,
      inputs,
    });
    if (!call.ok || call.error) {
      return errorResponse(call.error ?? { code: "unknown", message: "upstream error" });
    }
    // The last event of a completed run is the `completed` event; surface it
    // as `result` for convenience while keeping the full event log.
    const last = call.events[call.events.length - 1] as Record<string, unknown> | undefined;
    return jsonResponse({
      runId: call.runId,
      status: "completed",
      result: last && last["kind"] === "completed" ? last : undefined,
      events: call.events,
    });
  }

  // GET /v1/runs/{id}  ->  workflow.run.search scoped to the run id
  m = path.match(/^\/v1\/runs\/([^/]+)$/);
  if (m && req.method === "GET") {
    const id = decodeURIComponent(m[1]);
    const call = await callSwamp(token, "workflow.run.search", {
      query: id,
      limit: 1,
    });
    if (!call.ok || call.error) {
      return errorResponse(call.error ?? { code: "unknown", message: "upstream error" });
    }
    const payload = (call.responses[0] ?? {}) as Record<string, unknown>;
    const results = dig<unknown[]>(payload, "payload", "data", "results") ?? [];
    return jsonResponse({ runId: id, runs: results });
  }

  return jsonResponse({ error: { code: "not_found", message: `No route for ${req.method} ${path}` } }, 404);
}

console.log(`swamp-chatgpt-gateway listening on :${PORT} -> ${SWAMP_SERVE_URL}`);
Deno.serve({ port: PORT }, handler);

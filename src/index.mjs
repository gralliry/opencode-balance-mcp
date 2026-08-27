#!/usr/bin/env node
/**
 * opencode-balance-mcp
 *
 * MCP server (stdio) for querying OpenCode subscription data:
 *   - query_go_usage     → Go quota (rolling/weekly/monthly usage percent)
 *   - query_zen_balance  → Zen prepaid balance (pay-as-you-go credits)
 *
 * Usage:
 *   npx -y opencode-balance-mcp \
 *     --workspace-id wrk_xxx \
 *     --auth-cookie "Fe26.2**..."
 *
 * Credentials priority:
 *   1. CLI args:        --workspace-id / --auth-cookie
 *   2. Environment:     OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE
 *
 * Module layout:
 *   src/index.mjs — MCP protocol, credentials, page fetching (I/O glue)
 *   src/http.mjs  — timeout / retry / backoff network policy
 *   src/parse.mjs — pure parsing + formatting helpers (unit-testable)
 */
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fetchWithRetry } from "./http.mjs";
import {
    extractRscObject,
    extractScalar,
    formatWindow,
    formatZen,
} from "./parse.mjs";

// Read version from package.json so releasing only needs `npm version`.
const require = createRequire(import.meta.url);
const VERSION = require("../package.json").version;
const TOOL_NAME_GO = "query_go_usage";
const TOOL_NAME_ZEN = "query_zen_balance";

/* ---------------- Constants ---------------- */

const DASHBOARD_URL = "https://opencode.ai"; // OpenCode dashboard base URL
const LIMITS = { rolling: 12, weekly: 30, monthly: 60 }; // USD, from https://opencode.ai/docs/go/

/* ---------------- CLI argument parsing ---------------- */

/**
 * Parse `--workspace-id` / `--auth-cookie` from the CLI arguments.
 * Supports both `--flag value` and `--flag=value` forms.
 *
 * @param {string[]} argv - Raw argument list (e.g. process.argv.slice(2)).
 * @returns {{workspaceId: string|null, authCookie: string|null}} Parsed flags.
 */
function parseArgs(argv) {
    const args = { workspaceId: null, authCookie: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--workspace-id") args.workspaceId = argv[++i];
        else if (a === "--auth-cookie") args.authCookie = argv[++i];
        else if (a.startsWith("--workspace-id="))
            args.workspaceId = a.slice("--workspace-id=".length);
        else if (a.startsWith("--auth-cookie="))
            args.authCookie = a.slice("--auth-cookie=".length);
    }
    return args;
}

/* ---------------- Credentials (loaded once, cached) ---------------- */

// Credentials are resolved once and cached; subsequent calls skip re-parsing.
let cachedCredentials = null;

/**
 * Resolve credentials from CLI args, falling back to environment variables.
 * Precedence: CLI > env. Throws if neither source provides a full pair.
 *
 * @returns {{workspaceId: string, authCookie: string}} Credentials.
 */
function loadCredentials() {
    if (cachedCredentials) return cachedCredentials;

    const cli = parseArgs(process.argv.slice(2));
    const envId = process.env.OPENCODE_GO_WORKSPACE_ID;
    const envCookie = process.env.OPENCODE_GO_AUTH_COOKIE;

    if (cli.workspaceId && cli.authCookie) {
        cachedCredentials = {
            workspaceId: cli.workspaceId,
            authCookie: cli.authCookie,
        };
    } else if (envId && envCookie) {
        cachedCredentials = {
            workspaceId: envId,
            authCookie: envCookie,
        };
    } else {
        throw new Error(
            "Missing credentials: provide --workspace-id / --auth-cookie CLI args, " +
                "or env vars OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE.",
        );
    }
    return cachedCredentials;
}

/* ---------------- Page fetching (I/O glue) ---------------- */

/**
 * Resolve the auth cookie, prefixed with `auth=` if not already present.
 *
 * @returns {string} Cookie value for the Cookie header.
 */
function buildAuthCookie() {
    const { authCookie } = loadCredentials();
    return authCookie.startsWith("auth=") ? authCookie : `auth=${authCookie}`;
}

/**
 * Fetch a dashboard page, authenticated with the auth cookie.
 * Returns the page body as HTML text; auth failures raise a clear error.
 *
 * @param {string} path - URL path relative to the dashboard base (e.g. "/workspace/...").
 * @returns {Promise<string>} The HTML text of the page.
 */
async function fetchPage(path) {
    const creds = loadCredentials();
    const url = `${DASHBOARD_URL}${path}`;

    const resp = await fetchWithRetry(url, {
        headers: { Cookie: buildAuthCookie() },
        // Don't silently follow to the login page when the cookie expires:
        // a 3xx here means the session is invalid.
        redirect: "manual",
    });
    if (resp.status === 401 || resp.status === 403) {
        throw new Error(
            `Authentication failed (HTTP ${resp.status}): auth cookie may be expired. Re-login to opencode.ai and refresh it.`,
        );
    }
    if (resp.status >= 300 && resp.status < 400) {
        throw new Error(
            `Authentication failed: dashboard redirected (HTTP ${resp.status} → ${resp.headers.get("location") ?? "?"}). The auth cookie may be expired or the workspace id invalid.`,
        );
    }
    if (!resp.ok) {
        throw new Error(`Request failed (HTTP ${resp.status})`);
    }
    return resp.text();
}

// RSC payload shape: rollingUsage:$R[31]={status:"ok",resetInSec:8660,usagePercent:1}
// (parsing helpers live in ./parse.mjs)

/**
 * Query Go subscription quota across all three windows and format the result.
 *
 * @returns {Promise<Object>} Timestamped usage object with rolling/weekly/monthly windows.
 */
async function fetchGoUsage() {
    const creds = loadCredentials();
    const html = await fetchPage(
        `/workspace/${encodeURIComponent(creds.workspaceId)}/go`,
    );

    const rolling = extractRscObject(html, "rollingUsage");
    const weekly = extractRscObject(html, "weeklyUsage");
    const monthly = extractRscObject(html, "monthlyUsage");
    if (!rolling && !weekly && !monthly) {
        throw new Error(
            "Could not extract usage data from the page: structure may have changed, or this workspace has no Go subscription",
        );
    }

    return {
        timestamp: new Date().toISOString(),
        workspaceId: creds.workspaceId,
        rolling: formatWindow(rolling, LIMITS.rolling),
        weekly: formatWindow(weekly, LIMITS.weekly),
        monthly: formatWindow(monthly, LIMITS.monthly),
    };
}

/**
 * Query Zen prepaid balance (pay-as-you-go) by reading the dashboard page
 * and parsing the embedded SolidJS SSR scalars.
 *
 * @returns {Promise<Object>} Timestamped balance object with USD + autoReload info.
 */
async function fetchZenBalance() {
    const creds = loadCredentials();
    const html = await fetchPage(
        `/workspace/${encodeURIComponent(creds.workspaceId)}`,
    );

    // Extract the raw fields shipped by the page (SSR scalars).
    const raw = {
        balanceRaw: extractScalar(html, "balance"),
        reloadAmount: extractScalar(html, "reloadAmount"),
        reloadTrigger: extractScalar(html, "reloadTrigger"),
        reloadAmountMin: extractScalar(html, "reloadAmountMin"),
        reloadTriggerMin: extractScalar(html, "reloadTriggerMin"),
    };
    const formatted = formatZen(raw, creds.workspaceId);
    if (!formatted) {
        throw new Error(
            "Could not extract Zen balance data from the page: structure may have changed, or this workspace has no Zen (balance-based) billing",
        );
    }
    return { timestamp: new Date().toISOString(), ...formatted };
}

/* ---------------- MCP stdio protocol (JSON-RPC 2.0, newline-delimited) ---------------- */

// Tool metadata advertised via tools/list to the MCP client.
const tools = [
    {
        name: TOOL_NAME_GO,
        description:
            "Query OpenCode Go subscription quota: rolling (5h) / weekly / monthly usage percent, estimated USD spent and reset countdown. " +
            "No arguments needed; credentials are provided at startup via CLI args (--workspace-id / --auth-cookie) or env vars.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: TOOL_NAME_ZEN,
        description:
            "Query OpenCode Zen prepaid balance (pay-as-you-go): balance in 1e-8 USD units (negative = credit), formatted USD, and auto-reload settings. " +
            "No arguments needed; credentials are provided at startup via CLI args (--workspace-id / --auth-cookie) or env vars.",
        inputSchema: { type: "object", properties: {} },
    },
];

// Tool name → async handler map (hoisted once, used by tools/call).
const TOOL_HANDLERS = {
    [TOOL_NAME_GO]: fetchGoUsage,
    [TOOL_NAME_ZEN]: fetchZenBalance,
};

// Readline interface over stdin; one line = one JSON-RPC message (MCP stdio transport).
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

/** Write a JSON-RPC message to stdout, newline-delimited (MCP stdio framing). */
function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Send an error response for the given id. */
function sendError(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Send a tool-call result, optionally flagged as an error. */
function sendToolResult(id, text, isError) {
    send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError },
    });
}

/** Handle one JSON-RPC message line (one message per line on stdin). */
async function handleMessage(line) {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return; // ignore malformed JSON
    }
    const { id, method, params } = msg;

    // Notifications never get a reply.
    if (
        method === "notifications/initialized" ||
        method === "notifications/cancelled"
    )
        return;
    if (method === "ping") {
        // Respond only to request-style pings (those carrying an id).
        if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        return;
    }
    // Everything below is a request; JSON-RPC requests carry an id.
    if (id === undefined) return;

    try {
        switch (method) {
            case "initialize":
                // Handshake: announce protocol version, capabilities and server info.
                send({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: {} },
                        serverInfo: {
                            name: "opencode-balance-mcp",
                            version: VERSION,
                        },
                    },
                });
                break;

            case "tools/list":
                send({ jsonrpc: "2.0", id, result: { tools } });
                break;

            case "tools/call": {
                const name = params?.name;
                const args = params?.arguments;
                // arguments is optional but, when present, must be an object.
                if (
                    args !== undefined &&
                    (typeof args !== "object" || args === null)
                ) {
                    sendError(id, -32602, "Tool arguments must be an object");
                    break;
                }
                const handler = TOOL_HANDLERS[name];
                if (!handler) {
                    sendError(id, -32602, `Unknown tool: ${name}`);
                    break;
                }
                try {
                    const data = await handler();
                    sendToolResult(id, JSON.stringify(data, null, 2), false);
                } catch (err) {
                    sendToolResult(id, `Error: ${err.message}`, true);
                }
                break;
            }

            default:
                sendError(id, -32601, `Unknown method: ${method}`);
        }
    } catch (err) {
        // Catch-all for unexpected handler errors.
        sendError(id, -32603, err.message);
    }
}

rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
        await handleMessage(line);
    } catch (err) {
        process.stderr.write(`internal error: ${err.stack ?? err}\n`);
    }
});

// Exit cleanly when the client goes away (stdin EOF).
rl.on("close", () => process.exit(0));

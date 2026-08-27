// MCP server layer: JSON-RPC stdio protocol + the tool implementations.
// Network access goes through ./http.mjs; parsing/formatting through ./parse.mjs.

import { createInterface } from "node:readline";
import { fetchPage } from "./http.mjs";
import {
    extractRscObject,
    extractScalar,
    formatWindow,
    formatZen,
} from "./parse.mjs";

/* ---------------- Tool domain constants ---------------- */

const DASHBOARD_URL = "https://opencode.ai"; // OpenCode dashboard base URL
const LIMITS = { rolling: 12, weekly: 30, monthly: 60 }; // USD, from https://opencode.ai/docs/go/
const TOOL_NAME_GO = "query_go_usage";
const TOOL_NAME_ZEN = "query_zen_balance";

/* ---------------- Tool implementations ---------------- */

/**
 * Query Go subscription quota across all three windows.
 *
 * @param {{workspaceId: string, authCookie: string}} creds - Resolved credentials.
 * @returns {Promise<Object>} Timestamped usage object with rolling/weekly/monthly windows.
 */
async function fetchGoUsage(creds) {
    const html = await fetchPage(
        `${DASHBOARD_URL}/workspace/${encodeURIComponent(creds.workspaceId)}/go`,
        creds.authCookie,
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
 * Query Zen prepaid balance (pay-as-you-go) by parsing the dashboard page's
 * embedded SolidJS SSR scalars.
 *
 * @param {{workspaceId: string, authCookie: string}} creds - Resolved credentials.
 * @returns {Promise<Object>} Timestamped balance object with USD + autoReload info.
 */
async function fetchZenBalance(creds) {
    const html = await fetchPage(
        `${DASHBOARD_URL}/workspace/${encodeURIComponent(creds.workspaceId)}`,
        creds.authCookie,
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

/**
 * Create the MCP server. `getCredentials` is called lazily per tool call so
 * a missing-config error surfaces as a tool error, not at startup.
 *
 * @param {Object} opts
 * @param {string} opts.version - Server version (echoed in initialize).
 * @param {() => {workspaceId: string, authCookie: string}} opts.getCredentials - Credential resolver.
 * @returns {{start: () => void}} The server handle.
 */
export function createMcpServer({ version, getCredentials }) {
    // Tool name → handler (wraps the shared implementations with credentials).
    const handlers = {
        [TOOL_NAME_GO]: async () => fetchGoUsage(getCredentials()),
        [TOOL_NAME_ZEN]: async () => fetchZenBalance(getCredentials()),
    };

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
                                version,
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
                        sendError(
                            id,
                            -32602,
                            "Tool arguments must be an object",
                        );
                        break;
                    }
                    const handler = handlers[name];
                    if (!handler) {
                        sendError(id, -32602, `Unknown tool: ${name}`);
                        break;
                    }
                    try {
                        const data = await handler();
                        sendToolResult(
                            id,
                            JSON.stringify(data, null, 2),
                            false,
                        );
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

    return {
        /** Start listening on stdin; exits cleanly when the client goes away. */
        start() {
            rl.on("line", async (line) => {
                if (!line.trim()) return;
                try {
                    await handleMessage(line);
                } catch (err) {
                    process.stderr.write(`internal error: ${err.stack ?? err}\n`);
                }
            });
            rl.on("close", () => process.exit(0));
        },
    };
}
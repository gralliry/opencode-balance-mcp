#!/usr/bin/env node
/**
 * opencode-balance-mcp — entry point.
 *
 * Resolves credentials (CLI args > env) and starts the MCP server.
 * Architecture:
 *   src/index.mjs — entry: CLI/env credentials, wiring, startup
 *   src/mcp.mjs   — MCP stdio protocol layer + tool implementations
 *   src/http.mjs  — HTTP layer: timeout, retry, redirect/auth error handling
 *   src/parse.mjs — pure parsing + formatting helpers (unit-testable)
 *
 * Usage:
 *   npx -y opencode-balance-mcp \
 *     --workspace-id wrk_xxx \
 *     --auth-cookie "Fe26.2**..."
 *
 * Credentials priority:
 *   1. CLI args:        --workspace-id / --auth-cookie
 *   2. Environment:     OPENCODE_GO_WORKSPACE_ID / OPENCODE_GO_AUTH_COOKIE
 */
import { createRequire } from "node:module";
import { createMcpServer } from "./mcp.mjs";

// Read version from package.json so releasing only needs `npm version`.
const require = createRequire(import.meta.url);
const VERSION = require("../package.json").version;

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

/* ---------------- Credentials (resolved once, cached) ---------------- */

let cachedCredentials = null;

/**
 * Resolve credentials from CLI args, falling back to environment variables.
 * Precedence: CLI > env. Throws if neither source provides a full pair.
 * Called lazily per tool call so a missing-config error surfaces as a tool
 * error rather than killing the server at startup.
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

/* ---------------- Startup ---------------- */

createMcpServer({ version: VERSION, getCredentials: loadCredentials }).start();
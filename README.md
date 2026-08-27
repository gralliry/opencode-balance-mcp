# opencode-balance-mcp

An [MCP](https://modelcontextprotocol.io) server (stdio) that exposes your **OpenCode** subscription data as tools — your Go quota and your Zen prepaid balance — to any MCP-capable client (pi, Claude Desktop, opencode, Cursor, and more).

- **`query_go_usage`** — OpenCode Go quota across rolling (5h), weekly, and monthly windows. Fetches the `/workspace/{id}/go` page and parses the embedded RSC payload.
- **`query_zen_balance`** — OpenCode Zen prepaid balance. Fetches the workspace dashboard page and parses the embedded SolidJS SSR scalars.

Requests are retried with backoff on transient failures (5xx, 429 — honouring
`Retry-After`) and time out after 15s.

Zero dependencies. Node.js ≥ 18.

## Install & Run

```bash
npx -y opencode-balance-mcp \
  --workspace-id wrk_xxx \
  --auth-cookie "Fe26.2**..."
```

## Credentials

The server needs your OpenCode **workspace ID** and **auth cookie**. Priority order:

1. **CLI args**: `--workspace-id` / `--auth-cookie`
2. **Environment**: `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE`

> ⚠️ `authCookie` is your OpenCode session cookie (starts with `Fe26.2**`). It expires — refresh it by
> logging into https://opencode.ai → DevTools → Application → Cookies → `auth`.

## Tools

### `query_go_usage`

No arguments. Returns the Go subscription quota for all three windows:

```json
{
  "timestamp": "...",
  "workspaceId": "wrk_...",
  "rolling":  { "status": "ok", "usagePercent": 1, "limitUsd": 12, "estSpentUsdLow": 0.12, "estSpentUsdHigh": 0.24, "resetsInSeconds": 8660, "resetsIn": "2h 24m" },
  "weekly":   { "status": "ok", "usagePercent": 1, "limitUsd": 30, "...": "..." },
  "monthly":  { "status": "ok", "usagePercent": 0, "limitUsd": 60, "...": "..." }
}
```

- `usagePercent` is an integer — `0%` simply means less than 1% of the window limit was used
  (5h **$12** / weekly **$30** / monthly **$60**). See [opencode.ai/docs/go](https://opencode.ai/docs/go/).
- `estSpentUsdLow/High` bracket the estimated spend for the current usage percent.
- `resetsIn` is a human-friendly countdown from `resetsInSeconds`.

### `query_zen_balance`

No arguments. Reads the workspace dashboard page and parses the Zen balance
(SolidJS SSR hydration data):

```json
{
  "timestamp": "...",
  "workspaceId": "wrk_...",
  "plan": "pay-as-you-go",
  "balanceRaw": 0,
  "balanceUsd": 0,
  "balanceFormatted": "$0.00",
  "autoReload": { "triggerUsd": 5, "triggerMinUsd": 5, "reloadUsd": 20, "reloadMinUsd": 10 },
  "reloadAmount": 20,
  "reloadTrigger": 5
}
```

- `balanceRaw` is an integer in **1e-8 USD units** (the same unit the dashboard
  client uses: `formatBalance = amount / 1e8`). Negative = prepaid credit,
  positive = amount owed.
- `balanceUsd` / `balanceFormatted` are derived from it; the sign shows up as
  `(credit)` / `(owed)` in the label.
- `autoReload` mirrors Zen's auto top-up: when the balance drops below
  `triggerUsd`, add `reloadUsd`.

> There is no official Zen balance API, so the server scrapes the dashboard the
> same way it probes Go quota. The parser lives in `src/parse.mjs` and may need
> updating if the page structure changes.

## Configure in MCP clients

The server speaks **MCP over stdio**: each client just launches it as a local process
(`npx -y opencode-balance-mcp`) and passes your credentials through the client's config
— workspace ID and auth cookie via the `env` block, or via CLI args when running manually
(see [Credentials](#credentials)). The two tools then appear like any other MCP tool.

### pi (`~/.pi/agent/mcp.json`)

```json
{
  "mcpServers": {
    "opencode-balance": {
      "command": "npx",
      "args": ["-y", "opencode-balance-mcp"],
      "env": {
        "OPENCODE_GO_WORKSPACE_ID": "wrk_xxx",
        "OPENCODE_GO_AUTH_COOKIE": "Fe26.2**..."
      }
    }
  }
}
```

### opencode (`~/.config/opencode/opencode.json`)

```json
{
  "mcp": {
    "opencode-balance": {
      "type": "local",
      "command": ["npx", "-y", "opencode-balance-mcp"],
      "environment": {
        "OPENCODE_GO_WORKSPACE_ID": "wrk_xxx",
        "OPENCODE_GO_AUTH_COOKIE": "Fe26.2**..."
      }
    }
  }
}
```

## Development

```bash
npm start      # run the server directly
npm test       # unit tests (parser, zen formatting, HTTP retry policy) + a protocol smoke test
```

The protocol smoke test (`test/test.mjs`) launches the server over stdio and verifies
`initialize`, `tools/list`, `tools/call`, and
tools/call error handling. Without credentials it expectedly fails the two tool calls with
an `isError` result.

## Architecture

- `src/index.mjs` — MCP stdio protocol, credentials (CLI/env), page fetching glue
- `src/http.mjs` — network policy: timeout, retry-with-backoff, 429/`Retry-After` handling
- `src/parse.mjs` — pure parsing/formatting helpers (no I/O, unit-tested directly)

## Publish

```bash
npm publish
```

## License

MIT

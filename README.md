<img src="https://raw.githubusercontent.com/dominikduda/savage_mcp/refs/heads/master/savage_mcp_logo.png" width="500" />

# savage_mcp

`savage_mcp` is a **least-privilege browser-reading MCP** for [Savage Scraper](https://github.com/dominikduda/savage_scraper). It lets an MCP client open and scrape explicitly allowlisted pages through the Chrome profile you already use.

It uses standard local MCP stdio transport and can be launched by any MCP host that supports local stdio servers.

## Why this exists

Many browser MCPs are automation tools: they can click, type, submit forms, execute scripts and operate applications. That is useful when you want an agent to control a browser.

`savage_mcp` is for a different job:

> **Let the AI read selected websites from your existing logged-in Chrome session without also giving it a general browser-control API.**

### Your real browser and your existing session

Savage Scraper runs in your normal Chrome profile. When `savage_mcp` opens an allowlisted site, that page uses the browser session you already have, including existing authentication and application state.

There is no separate headless browser to maintain, no automation profile whose cookies need to be kept in sync, and no separate machine just to reproduce access you already have in Chrome.

Chrome remains a normal human browser at the same time. Savage MCP owns one dedicated agent tab for its operations; your other tabs remain yours, and Savage Scraper restores the previously active tab when possible.

### A small API on purpose

The MCP tool surface is intentionally limited:

- `savage_open(url)` — validate the URL against `allowed_hosts` and optional `allowed_paths`, open or reuse the dedicated Chrome tab, perform the bounded lazy-load pass and return simplified HTML.
- `savage_scrape()` — re-scrape the existing dedicated Savage MCP tab.
- `savage_status()` — report bridge/config/extension status.

There are intentionally no tools for:

- clicking elements;
- typing into pages;
- submitting forms;
- arbitrary JavaScript execution; or
- unrestricted browser control.

That is a feature, not an unfinished automation API. If you only need the model to **read** Jira, GitHub, documentation, dashboards, internal tools or other authenticated sites, giving it fewer browser capabilities reduces the accidental write/action surface.

It is not a guarantee that opening a page can never have side effects; websites can implement their own behavior on page load. The design simply avoids exposing general mutation primitives to the MCP client.

If your task requires an agent to operate websites, complete workflows, fill forms or debug the browser, use a full browser-automation tool instead.

### Explicit site boundary

`allowed_hosts` defines which HTTP/HTTPS hosts the MCP may open. Optional `allowed_paths` rules can narrow an allowed host to specific URL paths. The combined policy is enforced by both `savage_mcp` and Savage Scraper after the local bridge is authenticated.

This gives the setup a deliberately simple trust model:

```text
existing Chrome session
+ explicit allowed_hosts
+ optional per-host allowed_paths
+ read-oriented MCP tools
= browser context for the model
```

## Architecture

```text
MCP host
    |
    | MCP over stdio
    v
savage_mcp
    |
    | authenticated WebSocket
    | ws://127.0.0.1:<port>
    v
Savage Scraper
Chrome extension
    |
    v
normal Chrome profile
```

The WebSocket server binds only to `127.0.0.1`. A shared bridge token is used for mutual authentication between `savage_mcp` and the extension. Ordinary web pages are rejected by the bridge's Chrome-extension origin check.

## Requirements

- macOS, Linux, or another platform where Node.js and Chrome run on the same host
- Node.js 20 or newer
- Google Chrome
- Savage Scraper with MCP support installed: <https://github.com/dominikduda/savage_scraper>

## Install

```bash
npm install
npm run init
```

`npm run init` creates:

```text
~/.config/savage_mcp/config.json
```

If `XDG_CONFIG_HOME` is set, it is respected. You can also set `SAVAGE_MCP_CONFIG` to use an explicit configuration path.

The generated configuration contains a random bridge token and an empty whitelist:

```json
{
  "bridge_port": 8765,
  "bridge_token": "<random 64-character token>",
  "allowed_hosts": [],
  "allowed_paths": {},
  "close_after_scrape": false,
  "agent_tab_close_seconds": 90
}
```

### Configure allowed hosts

Edit `allowed_hosts` with the domains the MCP is permitted to open and scrape. If a host has no `allowed_paths` entry, every path on that already-allowed host remains available:

```json
{
  "allowed_hosts": [
    "jira.company.com",
    "github.com",
    "*.internal.example.com"
  ]
}
```

An exact host permits every path on that host:

```text
jira.company.com
```

permits:

```text
https://jira.company.com/
https://jira.company.com/browse/ABC-123
https://jira.company.com/anything/else?x=1
```

It does not permit `other.company.com`.

A wildcard such as:

```text
*.internal.example.com
```

permits subdomains such as `one.internal.example.com` and `deep.one.internal.example.com`, but not the bare `internal.example.com`. Add both patterns if you need both.

Global wildcard patterns are deliberately rejected.

### Optionally restrict paths

`allowed_paths` is an optional tightening layer keyed by the same normalized host patterns used in `allowed_hosts`:

```json
{
  "allowed_hosts": [
    "github.com",
    "*.github.com",
    "jira.company.com"
  ],
  "allowed_paths": {
    "github.com": [
      "/dominikduda/savage_scraper/**"
    ],
    "*.github.com": []
  }
}
```

The rules are:

- `allowed_hosts` is always the outer gate. A path rule can only narrow a host that is already allowed.
- If an allowed host has **no** matching `allowed_paths` entry, all paths on that host are allowed.
- An empty array such as `"*.github.com": []` also means all paths on that matched host pattern are allowed.
- A non-empty array restricts that host pattern to the listed paths.
- A plain path such as `/owner/repo` is an exact match.
- A path ending in `/**`, such as `/owner/repo/**`, matches the base path and everything below it.
- Other `*` wildcard placement is rejected. Path rules cannot contain a query string or fragment; matching uses the URL pathname only and is case-sensitive.
- Every `allowed_paths` key must also be present in `allowed_hosts`.

If more than one allowed host pattern matches a hostname, the most specific one controls the path policy: an exact hostname wins over a wildcard, and a longer wildcard suffix wins over a broader wildcard. This prevents a broad unrestricted rule from bypassing a narrower restriction.

For GitHub repository-only access, for example:

```json
{
  "allowed_hosts": ["github.com"],
  "allowed_paths": {
    "github.com": [
      "/dominikduda/savage_scraper/**"
    ]
  }
}
```

This allows the repository root and its descendants while rejecting other `github.com` paths. As with `allowed_hosts`, `*.github.com` does not match the bare `github.com`; add both host patterns if you need both.

### Agent-tab closing

`close_after_scrape` controls whether Savage Scraper closes the dedicated MCP tab immediately after a successful `savage_open` or `savage_scrape` operation. The result is captured before the tab is closed. The default is `false`, which preserves the reusable-tab behavior.

```json
"close_after_scrape": false
```

`agent_tab_close_seconds` controls the inactivity fallback. When `close_after_scrape` is `false`, it closes the reusable tab after that idle period. When `close_after_scrape` is `true`, it still acts as a safety fallback if a scrape fails before the immediate-close path completes. The allowed range remains 30–3600 seconds; the default is 90.

## Configure Savage Scraper

1. Install/update [Savage Scraper](https://github.com/dominikduda/savage_scraper).
2. Open `chrome://extensions`.
3. Find **Savage Scraper** and open **Extension options**.
4. Under **MCP integration**, paste the `bridge_token` from `~/.config/savage_mcp/config.json`.
5. Set the same bridge port (default `8765`).
6. Click **Enable MCP website access** and approve Chrome's optional HTTP/HTTPS site-access prompt.
7. Save the settings.

The optional broad Chrome host permission makes autonomous operation possible. The actual operational restriction is the `allowed_hosts` list plus any configured `allowed_paths` rules in `savage_mcp`; the extension receives that policy only after mutual bridge authentication and enforces it again on the Chrome side.

## Run directly

```bash
npm start
```

The process speaks MCP on stdout/stdin. Diagnostic logs go to stderr because stdout is reserved for the MCP protocol.

## MCP host configuration

Configure your MCP host to launch `savage_mcp` as a local stdio process:

```bash
node /absolute/path/to/savage_mcp/src/index.js
```

The process uses stdin/stdout for MCP. If your configuration file is somewhere other than the default location, set:

```text
SAVAGE_MCP_CONFIG=/absolute/path/to/config.json
```

Use your MCP host's normal local-server configuration to supply that command and optional environment variable.

### OpenCode example

For OpenCode, add a local MCP entry like this to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "savage": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/savage_mcp/src/index.js"
      ],
      "enabled": true
    }
  },
  "experimental": {
    "mcp_timeout": 300000
  }
}
```

If `savage_mcp` uses a non-default config path, add an `environment` object to the `savage` MCP entry with `SAVAGE_MCP_CONFIG` pointing to that file. The larger MCP timeout is useful for queued or slow browser reads.

## Config reload behavior

`allowed_hosts`, `allowed_paths`, `close_after_scrape` and `agent_tab_close_seconds` are re-read and synchronized before tool requests, so changes do not require source-code changes and normally do not require restarting the MCP process.

Changing `bridge_port` or `bridge_token` requires updating Savage Scraper's MCP options too. Restart `savage_mcp` after changing the port. A token change also requires the extension to reconnect with the matching token.

## Browser behavior

Savage Scraper owns exactly one dedicated MCP tab:

- `savage_open` creates it if necessary.
- Later `savage_open` calls navigate/reuse the same tab.
- Concurrent `savage_open` / `savage_scrape` tool calls are serialized in `savage_mcp` before they are sent across the bridge, so their individual bridge timeouts start only when each browser operation actually begins.
- Savage Scraper also serializes browser operations on the extension side as a second correctness boundary around the shared tab.
- The user's previously active Chrome tab is restored after the operation when possible.
- By default (`close_after_scrape: false`), the MCP tab closes after the configured inactivity timeout.
- With `close_after_scrape: true`, the MCP tab closes immediately after each successful scrape; a later `savage_open` creates it again as needed.
- Only HTTP/HTTPS URLs permitted by `allowed_hosts` and any matching non-empty `allowed_paths` rule can be opened or scraped.

Before each MCP scrape, Savage Scraper performs a bounded lazy-load pass on the **main page scroll only** using larger downward steps, then jumps directly back to the original position before extraction. The extension pins scripting work to Chrome's current main-document ID; transient main-document replacement is retried up to 3 times within a 60-second operation/retry budget. This is intended to handle ordinary redirects/reloads/document swaps without allowing infinite retries, and it is not a universal virtualized-content crawler.

## Security notes

- The bridge listens only on `127.0.0.1`.
- Browser WebSocket connections must originate from a Chrome extension.
- A shared bridge token is used for mutual HMAC authentication; the token itself is never sent over the socket.
- `allowed_hosts` and optional `allowed_paths` restrictions are enforced by both the MCP process and Savage Scraper.
- `savage_mcp` never exposes arbitrary page JavaScript execution.
- Treat the bridge token like a local secret. The generated config file is created with user-only permissions where supported.
- Scraped page data is returned to the MCP host. What the MCP host/model provider does with that data depends on your MCP host and model-provider configuration.

## Development

Syntax checks:

```bash
npm run check
```

Host-whitelist tests:

```bash
npm test
```

You can also test a local MCP server with the MCP Inspector after installing dependencies:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

## License

MIT

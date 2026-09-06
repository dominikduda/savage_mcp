# savage_mcp

`savage_mcp` is a local Model Context Protocol (MCP) server that lets MCP-compatible AI clients ask [Savage Scraper](https://github.com/dominikduda/savage_scraper) to open and scrape whitelisted pages in your normal Chrome browser.

It is **not OpenCode-specific**. It uses the standard local MCP stdio transport, so any MCP host that can launch a local stdio server can use it. OpenCode configuration is included below because that is the primary intended setup.

## Architecture

```text
MCP host (OpenCode, etc.)
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
 normal Chrome
```

The WebSocket server binds only to `127.0.0.1`. A shared bridge token is used for mutual authentication between `savage_mcp` and the extension. Ordinary web pages are rejected by the bridge's Chrome-extension origin check.

## What it can do

The initial tool surface is intentionally small:

- `savage_open(url)` — validates the URL against `allowed_hosts`, opens or reuses one dedicated Savage MCP Chrome tab, lets Savage Scraper perform its main-page lazy-load scroll pass, and returns the simplified HTML string.
- `savage_scrape()` — re-scrapes the existing dedicated Savage MCP tab.
- `savage_status()` — reports bridge/config/extension status.

It does **not** expose arbitrary JavaScript execution, generic clicking, typing, or unrestricted browser control.

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
  "close_after_scrape": false,
  "agent_tab_close_seconds": 90
}
```

### Configure allowed hosts

Edit `allowed_hosts` with the domains the MCP is permitted to open and scrape:

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

The optional broad Chrome host permission makes autonomous operation possible. The actual operational restriction is the `allowed_hosts` list in `savage_mcp`; the extension receives that list only after mutual bridge authentication and enforces it again on the Chrome side.

## Run directly

```bash
npm start
```

The process speaks MCP on stdout/stdin. Diagnostic logs go to stderr because stdout is reserved for the MCP protocol.

## OpenCode

Current OpenCode V2 configuration places local servers under `mcp.servers`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "savage_mcp": {
        "type": "local",
        "command": [
          "node",
          "/absolute/path/to/savage_mcp/src/index.js"
        ]
      }
    }
  }
}
```

If you keep the config somewhere other than the default path:

```jsonc
{
  "mcp": {
    "servers": {
      "savage_mcp": {
        "type": "local",
        "command": ["node", "/absolute/path/to/savage_mcp/src/index.js"],
        "environment": {
          "SAVAGE_MCP_CONFIG": "/absolute/path/to/config.json"
        }
      }
    }
  }
}
```

## Other MCP clients

`savage_mcp` is a generic local stdio MCP server. Configure another MCP host to execute:

```bash
node /absolute/path/to/savage_mcp/src/index.js
```

No OpenCode-specific protocol is used.

## Config reload behavior

`allowed_hosts`, `close_after_scrape` and `agent_tab_close_seconds` are re-read and synchronized before tool requests, so changes do not require source-code changes and normally do not require restarting the MCP process.

Changing `bridge_port` or `bridge_token` requires updating Savage Scraper's MCP options too. Restart `savage_mcp` after changing the port. A token change also requires the extension to reconnect with the matching token.

## Browser behavior

Savage Scraper owns exactly one dedicated MCP tab:

- `savage_open` creates it if necessary.
- Later `savage_open` calls navigate/reuse the same tab.
- The user's previously active Chrome tab is restored after the operation when possible.
- By default (`close_after_scrape: false`), the MCP tab closes after the configured inactivity timeout.
- With `close_after_scrape: true`, the MCP tab closes immediately after each successful scrape; a later `savage_open` creates it again as needed.
- Only HTTP/HTTPS URLs whose hostname matches `allowed_hosts` can be opened or scraped.

Before each MCP scrape, Savage Scraper performs a deliberately simple lazy-load pass on the **main page scroll only**: it remembers the initial scroll position, walks down the page while content/page height can still grow, walks back upward, restores the original position, then runs the normal Savage Scraper extraction. This is intended to trigger common lazy loading; it is not a universal virtualized-content crawler.

## Security notes

- The bridge listens only on `127.0.0.1`.
- Browser WebSocket connections must originate from a Chrome extension.
- A shared bridge token is used for mutual HMAC authentication; the token itself is never sent over the socket.
- `allowed_hosts` is enforced by both the MCP process and Savage Scraper.
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

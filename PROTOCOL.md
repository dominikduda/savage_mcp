# Savage local bridge protocol

This documents the private localhost protocol between `savage_mcp` and the Savage Scraper Chrome extension. It is deliberately small and is not a replacement for MCP; MCP is used between the AI host and `savage_mcp`.

## Transport

- WebSocket server: `ws://127.0.0.1:<bridge_port>`
- Server: `savage_mcp`
- Client: Savage Scraper's Manifest V3 service worker
- JSON text messages only
- Browser connections must have a `chrome-extension://<extension-id>` Origin

## Authentication

The bridge token is a shared secret configured on both sides. The token is never sent directly.

1. Server → extension:

```json
{
  "type": "hello_request",
  "clientNonce": "..."
}
```

2. Extension → server:

```json
{
  "type": "hello",
  "clientNonce": "...",
  "extensionId": "...",
  "extensionVersion": "1.2.1"
}
```

3. Server → extension:

```json
{
  "type": "challenge",
  "clientNonce": "...",
  "serverNonce": "...",
  "proof": "HMAC-SHA256(token, server:<clientNonce>:<serverNonce>)"
}
```

4. Extension verifies the server proof and replies:

```json
{
  "type": "auth",
  "proof": "HMAC-SHA256(token, client:<clientNonce>:<serverNonce>)"
}
```

5. Server verifies the client proof and replies:

```json
{
  "type": "authenticated"
}
```

Only after this handshake are configuration and requests accepted.

## Configuration synchronization

Server → extension:

```json
{
  "type": "config",
  "allowedHosts": ["jira.example.com", "github.com", "*.internal.example.com"],
  "allowedPaths": {"github.com": ["/dominikduda/savage_scraper/**"], "*.internal.example.com": []},
  "closeAfterScrape": false,
  "agentTabCloseSeconds": 90
}
```

Savage Scraper replaces its in-memory host/path policy with these values. `allowedHosts` is the outer gate. `allowedPaths` optionally narrows a matching host pattern: a missing key or an empty array means all paths on that already-allowed host, while a non-empty array allows only matching exact paths or trailing `/**` recursive prefixes. The most specific matching host pattern controls the path policy. The same policy is enforced by `savage_mcp` before an `open` request is sent and by Savage Scraper before opening or scraping the agent tab.

When `closeAfterScrape` is `true`, Savage Scraper closes its dedicated MCP tab after a successful `open` or `scrape` result has been captured. When it is `false` (the default), the tab remains reusable until `agentTabCloseSeconds` expires. The inactivity timeout also remains a fallback when an operation fails.

## Requests

Server → extension:

```json
{
  "type": "request",
  "id": "uuid",
  "action": "open",
  "payload": {
    "url": "https://jira.example.com/browse/ABC-123"
  }
}
```

Supported actions:

- `open` — open/reuse the dedicated agent tab, lazy-load-scroll, scrape and return content
- `scrape` — lazy-load-scroll and scrape the existing dedicated tab
- `status` — return extension/MCP state

Extension → server success:

```json
{
  "type": "response",
  "id": "uuid",
  "ok": true,
  "result": {}
}
```

Extension → server failure:

```json
{
  "type": "response",
  "id": "uuid",
  "ok": false,
  "error": "Human-readable error"
}
```

## Keepalive

The extension sends periodic `keepalive` JSON messages while connected. They have no application semantics; their purpose is to keep the Manifest V3 service worker/WebSocket alive.

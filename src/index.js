#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { SavageBridge } from './bridge.js';
import { readConfig } from './config.js';
import { assertAllowedUrl } from './hosts.js';

const bridge = new SavageBridge(readConfig);

try {
  bridge.start();
} catch (error) {
  console.error(`[savage_mcp] Could not start: ${error.message}`);
  process.exit(1);
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(error) {
  return {
    content: [{
      type: 'text',
      text: error instanceof Error ? error.message : String(error)
    }],
    isError: true
  };
}

function createServer() {
  const server = new McpServer(
    {
      name: 'savage_mcp',
      version: '0.2.0'
    },
    {
      instructions:
        'Savage MCP is intended for allowlisted page reading through the user\'s existing Chrome profile and authenticated browser session. Use savage_open to open and scrape an allowed URL in the dedicated Savage Scraper Chrome tab, including pages whose useful content depends on existing browser login/session state. Use savage_scrape to re-scrape that tab. URLs are restricted by the local savage_mcp allowed_hosts configuration. Savage MCP does not expose general click, type, form-submit, or arbitrary-JavaScript browser controls. The dedicated tab may close after a successful scrape when close_after_scrape is enabled.'
    }
  );

  server.registerTool(
    'savage_open',
    {
      title: 'Open and scrape URL',
      description:
        'Read an allowed http/https URL through the user\'s existing Chrome profile and authenticated browser session. Opens or reuses Savage Scraper\'s dedicated Chrome tab, performs the configured lazy-load scroll pass, and returns the full Savage Scraper output string, including page metadata and simplified HTML.',
      inputSchema: z.object({
        url: z.string().url().describe('Absolute http:// or https:// URL on an allowed host.')
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async ({ url }) => {
      try {
        const config = readConfig();
        const parsedUrl = assertAllowedUrl(url, config.allowedHosts);
        const result = await bridge.request('open', { url: parsedUrl.href });
        return textResult(result.content);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'savage_scrape',
    {
      title: 'Scrape Savage tab',
      description:
        'Re-scrape the existing dedicated Savage Scraper Chrome tab after a lazy-load scroll pass. Fails if no Savage MCP tab exists.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false
      }
    },
    async () => {
      try {
        const result = await bridge.request('scrape');
        return textResult(result.content);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'savage_status',
    {
      title: 'Savage MCP status',
      description:
        'Show local bridge connection state, configured allowed hosts, config path, and Savage Scraper agent-tab state.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true
      }
    },
    async () => {
      try {
        const config = readConfig();
        const localStatus = bridge.status();
        let extensionStatus = null;

        if (localStatus.connected) {
          try {
            extensionStatus = await bridge.request('status', {}, 10_000);
          } catch (error) {
            extensionStatus = { error: error.message };
          }
        }

        return textResult(JSON.stringify({
          config_path: config.configPath,
          bridge_port: config.bridgePort,
          allowed_hosts: config.allowedHosts,
          close_after_scrape: config.closeAfterScrape,
          agent_tab_close_seconds: config.agentTabCloseSeconds,
          bridge: localStatus,
          extension: extensionStatus
        }, null, 2));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

void serveStdio(createServer);
console.error('[savage_mcp] MCP server running on stdio.');

async function shutdown() {
  await bridge.stop();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

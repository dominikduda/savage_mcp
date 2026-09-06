import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeHostPatterns } from './hosts.js';

export const DEFAULT_BRIDGE_PORT = 8765;
export const DEFAULT_AGENT_TAB_CLOSE_SECONDS = 90;

export function getConfigPath() {
  if (process.env.SAVAGE_MCP_CONFIG) {
    return path.resolve(process.env.SAVAGE_MCP_CONFIG);
  }

  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');

  return path.join(configHome, 'savage_mcp', 'config.json');
}

function requireInteger(value, name, min, max) {
  const numeric = Number(value);

  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return numeric;
}

export function readConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `savage_mcp config not found at ${configPath}. Run \"npm run init\" in the savage_mcp repository first.`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${error.message}`);
  }

  const bridgeToken = String(parsed.bridge_token || '').trim();

  if (bridgeToken.length < 32) {
    throw new Error('bridge_token must contain at least 32 characters.');
  }

  return {
    configPath,
    bridgePort: requireInteger(
      parsed.bridge_port ?? DEFAULT_BRIDGE_PORT,
      'bridge_port',
      1024,
      65535
    ),
    bridgeToken,
    allowedHosts: normalizeHostPatterns(parsed.allowed_hosts ?? []),
    agentTabCloseSeconds: requireInteger(
      parsed.agent_tab_close_seconds ?? DEFAULT_AGENT_TAB_CLOSE_SECONDS,
      'agent_tab_close_seconds',
      30,
      3600
    )
  };
}

#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_AGENT_TAB_CLOSE_SECONDS,
  DEFAULT_BRIDGE_PORT,
  getConfigPath
} from './config.js';

const configPath = getConfigPath();

if (fs.existsSync(configPath)) {
  console.error(`Config already exists: ${configPath}`);
  console.error('Delete it manually if you intentionally want to regenerate the bridge token.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });

const config = {
  bridge_port: DEFAULT_BRIDGE_PORT,
  bridge_token: crypto.randomBytes(32).toString('hex'),
  allowed_hosts: [],
  agent_tab_close_seconds: DEFAULT_AGENT_TAB_CLOSE_SECONDS
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600
});

console.error(`Created ${configPath}`);
console.error('Next: add allowed_hosts, then copy bridge_token into Savage Scraper > Options > MCP integration.');

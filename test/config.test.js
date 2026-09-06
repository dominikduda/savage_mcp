import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readConfig } from '../src/config.js';

function withConfig(overrides, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'savage-mcp-config-'));
  const configPath = path.join(directory, 'config.json');
  const previousConfigPath = process.env.SAVAGE_MCP_CONFIG;

  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      bridge_port: 8765,
      bridge_token: 'x'.repeat(64),
      allowed_hosts: [],
      agent_tab_close_seconds: 90,
      ...overrides
    }, null, 2)}\n`
  );

  process.env.SAVAGE_MCP_CONFIG = configPath;

  try {
    return callback();
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.SAVAGE_MCP_CONFIG;
    } else {
      process.env.SAVAGE_MCP_CONFIG = previousConfigPath;
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('close_after_scrape defaults to false', () => {
  withConfig({}, () => {
    assert.equal(readConfig().closeAfterScrape, false);
  });
});

test('close_after_scrape can be enabled', () => {
  withConfig({ close_after_scrape: true }, () => {
    assert.equal(readConfig().closeAfterScrape, true);
  });
});

test('close_after_scrape rejects non-boolean values', () => {
  withConfig({ close_after_scrape: 'true' }, () => {
    assert.throws(
      () => readConfig(),
      /close_after_scrape must be a boolean/
    );
  });
});

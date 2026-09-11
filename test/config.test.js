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
      allowed_paths: {},
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


test('allowed_paths defaults to an empty object', () => {
  withConfig({}, () => {
    assert.deepEqual(readConfig().allowedPaths, {});
  });
});

test('allowed_paths is normalized against allowed_hosts', () => {
  withConfig({
    allowed_hosts: ['GITHUB.COM'],
    allowed_paths: {
      'github.com': ['/dominikduda/savage_scraper/**']
    }
  }, () => {
    assert.deepEqual(readConfig().allowedHosts, ['github.com']);
    assert.deepEqual(readConfig().allowedPaths, {
      'github.com': ['/dominikduda/savage_scraper/**']
    });
  });
});

test('allowed_paths rejects keys that are not present in allowed_hosts', () => {
  withConfig({
    allowed_hosts: ['github.com'],
    allowed_paths: {
      'api.github.com': []
    }
  }, () => {
    assert.throws(
      () => readConfig(),
      /allowed_paths key must also appear in allowed_hosts/
    );
  });
});

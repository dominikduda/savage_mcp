import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SharedSavageBridge } from '../src/shared_bridge.js';

class FakeBrowserBridge {
  constructor(id) {
    this.id = id;
    this.started = false;
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  status() {
    return {
      connected: this.started,
      extensionId: 'fake-extension',
      extensionVersion: '1.0.0',
      connectedAt: '2026-09-18T00:00:00.000Z'
    };
  }

  async request(action, payload) {
    if (!this.started) {
      throw new Error('Fake browser bridge is stopped.');
    }

    return {
      bridgeId: this.id,
      action,
      payload
    };
  }
}

test('multiple MCP instances share one browser bridge leader', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'savage-mcp-shared-'));
  const runtimeDirectory = path.join(directory, 'runtime');
  const configPath = path.join(directory, 'config.json');
  const configReader = () => ({ configPath });

  let browserBridgeCount = 0;
  const browserBridgeFactory = () =>
    new FakeBrowserBridge(++browserBridgeCount);

  const first = new SharedSavageBridge(configReader, {
    runtimeDirectory,
    browserBridgeFactory
  });
  const second = new SharedSavageBridge(configReader, {
    runtimeDirectory,
    browserBridgeFactory
  });

  try {
    await first.start();
    await second.start();

    const firstStatus = await first.status();
    const secondStatus = await second.status();

    assert.equal(firstStatus.role, 'leader');
    assert.equal(secondStatus.role, 'proxy');
    assert.equal(secondStatus.leaderPid, process.pid);
    assert.equal(browserBridgeCount, 1);

    const result = await second.request('open', {
      url: 'https://example.com/'
    });

    assert.deepEqual(result, {
      bridgeId: 1,
      action: 'open',
      payload: {
        url: 'https://example.com/'
      }
    });
  } finally {
    await second.stop();
    await first.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a proxy takes leadership after the old leader stops', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'savage-mcp-failover-'));
  const runtimeDirectory = path.join(directory, 'runtime');
  const configPath = path.join(directory, 'config.json');
  const configReader = () => ({ configPath });

  let browserBridgeCount = 0;
  const browserBridgeFactory = () =>
    new FakeBrowserBridge(++browserBridgeCount);

  const first = new SharedSavageBridge(configReader, {
    runtimeDirectory,
    browserBridgeFactory
  });
  const second = new SharedSavageBridge(configReader, {
    runtimeDirectory,
    browserBridgeFactory
  });

  try {
    await first.start();
    await second.start();
    await first.stop();

    const result = await second.request('scrape');

    assert.equal((await second.status()).role, 'leader');
    assert.equal(browserBridgeCount, 2);
    assert.deepEqual(result, {
      bridgeId: 2,
      action: 'scrape',
      payload: {}
    });
  } finally {
    await second.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

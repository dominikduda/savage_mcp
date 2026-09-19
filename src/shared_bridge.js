import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { SavageBridge } from './bridge.js';

const IPC_MAX_BYTES = 40 * 1024 * 1024;
const LEADER_WAIT_MS = 1500;
const LEADER_RETRY_MS = 50;
const STARTUP_GRACE_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function configKey(configPath) {
  return crypto
    .createHash('sha256')
    .update(path.resolve(configPath))
    .digest('hex')
    .slice(0, 16);
}

function defaultRuntimeDirectory(configPath) {
  const key = configKey(configPath);
  let directory = path.join(path.dirname(configPath), `.runtime-${key}`);

  if (
    process.platform !== 'win32' &&
    Buffer.byteLength(path.join(directory, 'bridge.sock')) > 96
  ) {
    const user = typeof process.getuid === 'function'
      ? String(process.getuid())
      : os.userInfo().username.replace(/[^a-zA-Z0-9_.-]/g, '_');

    directory = path.join(os.tmpdir(), `savage_mcp-${user}-${key}`);
  }

  return directory;
}

function ipcEndpoint(runtimeDirectory, configPath) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\savage_mcp-${configKey(configPath)}`;
  }

  return path.join(runtimeDirectory, 'bridge.sock');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function normalizedTimeout(timeoutMs, fallback = 90_000) {
  const numeric = Number(timeoutMs);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(numeric), 1000), 300_000);
}

export class SharedSavageBridge {
  constructor(configReader, options = {}) {
    this.configReader = configReader;
    this.browserBridgeFactory = options.browserBridgeFactory ??
      (() => new SavageBridge(configReader));
    this.runtimeDirectoryOverride = options.runtimeDirectory ?? null;

    this.role = 'starting';
    this.leaderPid = null;
    this.browserBridge = null;
    this.ipcServer = null;
    this.startPromise = null;
    this.operationQueue = Promise.resolve();
    this.ownerToken = crypto.randomUUID();
    this.stopping = false;

    this.runtimeDirectory = null;
    this.socketPath = null;
    this.lockPath = null;
    this.ownerPath = null;
  }

  start() {
    if (!this.startPromise) {
      this.startPromise = this.#startInternal();
    }

    return this.startPromise;
  }

  async stop() {
    this.stopping = true;

    if (this.role === 'leader') {
      const ipcClose = this.ipcServer
        ? new Promise(resolve => {
            this.ipcServer.close(() => resolve());
          }).catch(() => {})
        : Promise.resolve();

      this.ipcServer = null;

      if (this.browserBridge) {
        await this.browserBridge.stop().catch(() => {});
        this.browserBridge = null;
      }

      await ipcClose;
      await this.#removeOwnedArtifacts();
    }

    this.role = 'stopped';
  }

  async status() {
    await this.start();

    if (this.role === 'leader') {
      return this.#leaderStatus();
    }

    try {
      const status = await this.#sendIpc({ type: 'status' }, 5000);
      this.leaderPid = status.leaderPid ?? this.leaderPid;

      return {
        ...status,
        role: 'proxy',
        leaderPid: this.leaderPid
      };
    } catch {
      await this.#recoverProxy();

      if (this.role === 'leader') {
        return this.#leaderStatus();
      }

      const status = await this.#sendIpc({ type: 'status' }, 5000);
      this.leaderPid = status.leaderPid ?? this.leaderPid;

      return {
        ...status,
        role: 'proxy',
        leaderPid: this.leaderPid
      };
    }
  }

  async request(action, payload = {}, timeoutMs = 90_000) {
    await this.start();

    const timeout = normalizedTimeout(timeoutMs);

    if (this.role === 'leader') {
      return await this.#enqueueBrowserRequest(action, payload, timeout);
    }

    try {
      return await this.#sendIpc({
        type: 'request',
        action,
        payload,
        timeoutMs: timeout
      }, timeout + 2000);
    } catch {
      await this.#recoverProxy();

      if (this.role === 'leader') {
        return await this.#enqueueBrowserRequest(action, payload, timeout);
      }

      return await this.#sendIpc({
        type: 'request',
        action,
        payload,
        timeoutMs: timeout
      }, timeout + 2000);
    }
  }

  async #startInternal() {
    const config = this.configReader();

    this.runtimeDirectory = this.runtimeDirectoryOverride ??
      defaultRuntimeDirectory(config.configPath);
    this.socketPath = ipcEndpoint(this.runtimeDirectory, config.configPath);
    this.lockPath = path.join(this.runtimeDirectory, 'leader.lock');
    this.ownerPath = path.join(this.lockPath, 'owner.json');

    await fs.promises.mkdir(this.runtimeDirectory, {
      recursive: true,
      mode: 0o700
    });

    if (process.platform !== 'win32') {
      await fs.promises.chmod(this.runtimeDirectory, 0o700).catch(() => {});
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (this.stopping) {
        throw new Error('savage_mcp is shutting down.');
      }

      try {
        await fs.promises.mkdir(this.lockPath, { mode: 0o700 });
        await this.#becomeLeader();
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }

      const leader = await this.#waitForLeader(LEADER_WAIT_MS);

      if (leader) {
        this.role = 'proxy';
        this.leaderPid = leader.pid ?? null;
        console.error(
          `[savage_mcp] Shared bridge proxy connected to leader PID ${this.leaderPid ?? 'unknown'}.`
        );
        return;
      }

      const owner = await this.#readOwner();

      if (isPidAlive(owner?.pid)) {
        this.role = 'proxy';
        this.leaderPid = owner.pid;
        console.error(
          `[savage_mcp] Shared bridge leader PID ${owner.pid} is still starting; using proxy mode.`
        );
        return;
      }

      const lockAgeMs = await this.#lockAgeMs();

      if (owner == null && lockAgeMs < STARTUP_GRACE_MS) {
        await sleep(LEADER_RETRY_MS);
        continue;
      }

      await this.#removeStaleArtifacts();
    }

    throw new Error('Could not elect a shared Savage MCP bridge leader.');
  }

  async #becomeLeader() {
    const owner = {
      pid: process.pid,
      token: this.ownerToken,
      startedAt: new Date().toISOString()
    };

    await fs.promises.writeFile(
      this.ownerPath,
      `${JSON.stringify(owner)}\n`,
      { mode: 0o600 }
    );

    const browserBridge = this.browserBridgeFactory();
    this.browserBridge = browserBridge;

    try {
      await browserBridge.start();
      await this.#startIpcServer();
    } catch (error) {
      await browserBridge.stop().catch(() => {});
      this.browserBridge = null;
      await this.#removeOwnedArtifacts();
      throw error;
    }

    this.role = 'leader';
    this.leaderPid = process.pid;

    console.error(
      `[savage_mcp] Shared bridge leader PID ${process.pid} using ${this.socketPath}.`
    );
  }

  async #startIpcServer() {
    if (process.platform !== 'win32') {
      await fs.promises.unlink(this.socketPath).catch(error => {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    const server = net.createServer(socket => {
      this.#handleIpcConnection(socket);
    });

    this.ipcServer = server;

    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        server.listen(this.socketPath);
      });
    } catch (error) {
      this.ipcServer = null;
      throw error;
    }

    server.on('error', error => {
      console.error(`[savage_mcp] Shared bridge IPC error: ${error.message}`);
    });

    if (process.platform !== 'win32') {
      await fs.promises.chmod(this.socketPath, 0o600).catch(() => {});
    }
  }

  #handleIpcConnection(socket) {
    socket.setEncoding('utf8');

    let buffer = '';
    let handled = false;

    socket.on('data', chunk => {
      if (handled) {
        return;
      }

      buffer += chunk;

      if (Buffer.byteLength(buffer) > IPC_MAX_BYTES) {
        handled = true;
        socket.destroy(new Error('Shared Savage MCP IPC request is too large.'));
        return;
      }

      const newline = buffer.indexOf('\n');

      if (newline === -1) {
        return;
      }

      handled = true;
      const raw = buffer.slice(0, newline);

      void this.#handleIpcMessage(raw)
        .then(result => {
          socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        })
        .catch(error => {
          socket.end(`${JSON.stringify({
            ok: false,
            error: errorMessage(error)
          })}\n`);
        });
    });

    socket.on('error', () => {});
  }

  async #handleIpcMessage(raw) {
    let message;

    try {
      message = JSON.parse(raw);
    } catch {
      throw new Error('Invalid shared Savage MCP IPC JSON.');
    }

    if (message.type === 'ping') {
      return {
        pid: process.pid,
        role: 'leader'
      };
    }

    if (message.type === 'status') {
      return this.#leaderStatus();
    }

    if (message.type === 'request') {
      if (typeof message.action !== 'string' || !message.action) {
        throw new Error('Shared Savage MCP IPC request is missing an action.');
      }

      return await this.#enqueueBrowserRequest(
        message.action,
        message.payload ?? {},
        normalizedTimeout(message.timeoutMs)
      );
    }

    throw new Error(`Unknown shared Savage MCP IPC message type: ${message.type}`);
  }

  #leaderStatus() {
    return {
      ...this.browserBridge.status(),
      role: 'leader',
      leaderPid: process.pid
    };
  }

  #enqueueBrowserRequest(action, payload, timeoutMs) {
    const run = () => this.browserBridge.request(action, payload, timeoutMs);
    const result = this.operationQueue.then(run, run);

    this.operationQueue = result.catch(() => {});
    return result;
  }

  async #sendIpc(message, timeoutMs) {
    const timeout = normalizedTimeout(timeoutMs, 5000);

    return await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;

      const finish = callback => value => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        socket.destroy();
        callback(value);
      };

      const succeed = finish(resolve);
      const fail = finish(reject);

      const timer = setTimeout(() => {
        fail(new Error('Shared Savage MCP IPC request timed out.'));
      }, timeout);

      socket.setEncoding('utf8');

      socket.once('connect', () => {
        socket.write(`${JSON.stringify(message)}\n`);
      });

      socket.on('data', chunk => {
        buffer += chunk;

        if (Buffer.byteLength(buffer) > IPC_MAX_BYTES) {
          fail(new Error('Shared Savage MCP IPC response is too large.'));
          return;
        }

        const newline = buffer.indexOf('\n');

        if (newline === -1) {
          return;
        }

        let response;

        try {
          response = JSON.parse(buffer.slice(0, newline));
        } catch {
          fail(new Error('Invalid shared Savage MCP IPC response.'));
          return;
        }

        if (response.ok) {
          succeed(response.result);
        } else {
          fail(new Error(String(response.error || 'Shared Savage MCP IPC request failed.')));
        }
      });

      socket.once('error', fail);
      socket.once('close', () => {
        if (!settled) {
          fail(new Error('Shared Savage MCP IPC connection closed before a response.'));
        }
      });
    });
  }

  async #waitForLeader(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const result = await this.#sendIpc({ type: 'ping' }, 300);

        if (result?.role === 'leader') {
          return result;
        }
      } catch {
        // The elected process may still be bringing up the browser and IPC
        // listeners. Retry briefly before treating the lock as stale.
      }

      await sleep(LEADER_RETRY_MS);
    }

    return null;
  }

  async #recoverProxy() {
    if (this.stopping) {
      throw new Error('savage_mcp is shutting down.');
    }

    this.role = 'starting';
    this.leaderPid = null;
    this.startPromise = null;

    await this.start();
  }

  async #readOwner() {
    try {
      return JSON.parse(await fs.promises.readFile(this.ownerPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async #lockAgeMs() {
    try {
      const stat = await fs.promises.stat(this.lockPath);
      return Math.max(0, Date.now() - stat.mtimeMs);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  async #removeStaleArtifacts() {
    if (process.platform !== 'win32') {
      await fs.promises.unlink(this.socketPath).catch(error => {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    const stalePath = `${this.lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;

    try {
      await fs.promises.rename(this.lockPath, stalePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }

      throw error;
    }

    await fs.promises.rm(stalePath, { recursive: true, force: true });
  }

  async #removeOwnedArtifacts() {
    const owner = await this.#readOwner();

    if (owner?.token !== this.ownerToken) {
      return;
    }

    if (process.platform !== 'win32') {
      await fs.promises.unlink(this.socketPath).catch(error => {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    await fs.promises.rm(this.lockPath, { recursive: true, force: true });
  }
}

import crypto from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

function safeEqualHex(expectedHex, actualHex) {
  if (typeof actualHex !== 'string') {
    return false;
  }

  let expected;
  let actual;

  try {
    expected = Buffer.from(expectedHex, 'hex');
    actual = Buffer.from(actualHex, 'hex');
  } catch {
    return false;
  }

  return expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hmac(token, message) {
  return crypto.createHmac('sha256', token).update(message).digest('hex');
}

function isExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(String(origin || ''));
}

export class SavageBridge {
  constructor(configReader) {
    this.configReader = configReader;
    this.wss = null;
    this.socket = null;
    this.socketMeta = null;
    this.pending = new Map();
    this.lastPushedConfig = '';
  }

  start() {
    const config = this.configReader();

    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: config.bridgePort,
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
      verifyClient: ({ origin }) => isExtensionOrigin(origin)
    });

    this.wss.on('connection', (socket, request) => {
      this.#handleConnection(socket, request);
    });

    this.wss.on('listening', () => {
      console.error(`[savage_mcp] Chrome bridge listening on ws://127.0.0.1:${config.bridgePort}`);
    });

    this.wss.on('error', error => {
      console.error(`[savage_mcp] WebSocket server error: ${error.message}`);
    });
  }

  async stop() {
    for (const { reject } of this.pending.values()) {
      reject(new Error('savage_mcp is shutting down.'));
    }
    this.pending.clear();

    if (this.socket) {
      this.socket.close(1001, 'Server shutting down');
      this.socket = null;
    }

    if (this.wss) {
      await new Promise(resolve => this.wss.close(resolve));
      this.wss = null;
    }
  }

  isConnected() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.socketMeta?.authenticated);
  }

  status() {
    return {
      connected: this.isConnected(),
      extensionId: this.socketMeta?.extensionId ?? null,
      extensionVersion: this.socketMeta?.extensionVersion ?? null,
      connectedAt: this.socketMeta?.connectedAt ?? null
    };
  }

  async syncConfig() {
    if (!this.isConnected()) {
      return;
    }

    const config = this.configReader();
    const payload = {
      allowedHosts: config.allowedHosts,
      agentTabCloseSeconds: config.agentTabCloseSeconds
    };
    const serialized = JSON.stringify(payload);

    if (serialized === this.lastPushedConfig) {
      return;
    }

    this.socket.send(JSON.stringify({ type: 'config', ...payload }));
    this.lastPushedConfig = serialized;
  }

  async request(action, payload = {}, timeoutMs = 90_000) {
    if (!this.isConnected()) {
      throw new Error(
        'Savage Scraper is not connected. Ensure Chrome is running, MCP integration is enabled in Savage Scraper, and the bridge token/port match.'
      );
    }

    await this.syncConfig();

    const id = crypto.randomUUID();

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Savage Scraper request timed out: ${action}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.socket.send(JSON.stringify({
        type: 'request',
        id,
        action,
        payload
      }));
    });
  }

  #handleConnection(socket, request) {
    const origin = request.headers.origin;
    const clientNonce = crypto.randomBytes(24).toString('hex');
    const serverNonce = crypto.randomBytes(24).toString('hex');
    const config = this.configReader();
    const meta = {
      authenticated: false,
      clientNonce,
      serverNonce,
      extensionId: null,
      extensionVersion: null,
      connectedAt: null
    };

    const handshakeTimeout = setTimeout(() => {
      if (!meta.authenticated) {
        socket.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    socket.on('message', raw => {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(4002, 'Invalid JSON');
        return;
      }

      if (!meta.authenticated) {
        if (message.type === 'hello') {
          if (message.clientNonce !== clientNonce && message.clientNonce) {
            socket.close(4003, 'Invalid handshake');
            return;
          }

          meta.extensionId = String(message.extensionId || '');
          meta.extensionVersion = String(message.extensionVersion || '');
          meta.clientNonce = String(message.clientNonce || clientNonce);

          socket.send(JSON.stringify({
            type: 'challenge',
            clientNonce: meta.clientNonce,
            serverNonce,
            proof: hmac(config.bridgeToken, `server:${meta.clientNonce}:${serverNonce}`)
          }));
          return;
        }

        if (message.type === 'auth') {
          const expected = hmac(
            config.bridgeToken,
            `client:${meta.clientNonce}:${serverNonce}`
          );

          if (!safeEqualHex(expected, message.proof)) {
            socket.close(4004, 'Authentication failed');
            return;
          }

          clearTimeout(handshakeTimeout);
          meta.authenticated = true;
          meta.connectedAt = new Date().toISOString();

          if (this.socket && this.socket !== socket) {
            this.socket.close(4005, 'Replaced by a newer Savage Scraper connection');
          }

          this.socket = socket;
          this.socketMeta = meta;
          this.lastPushedConfig = '';

          socket.send(JSON.stringify({ type: 'authenticated' }));
          void this.syncConfig();
          console.error(`[savage_mcp] Savage Scraper connected (${meta.extensionId || origin}).`);
          return;
        }

        return;
      }

      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = this.pending.get(message.id);

        if (!pending) {
          return;
        }

        this.pending.delete(message.id);

        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(String(message.error || 'Savage Scraper request failed.')));
        }
      }
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimeout);

      if (this.socket === socket) {
        this.socket = null;
        this.socketMeta = null;
        this.lastPushedConfig = '';

        for (const { reject } of this.pending.values()) {
          reject(new Error('Savage Scraper disconnected.'));
        }
        this.pending.clear();

        console.error('[savage_mcp] Savage Scraper disconnected.');
      }
    });

    socket.on('error', error => {
      console.error(`[savage_mcp] Chrome bridge socket error: ${error.message}`);
    });

    socket.send(JSON.stringify({
      type: 'hello_request',
      clientNonce
    }));
  }
}

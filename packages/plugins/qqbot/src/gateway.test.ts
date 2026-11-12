import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createActivationScope, createPluginPaseoApi } from '@omp-desktop/plugin/server';
import type { PluginInstallation, PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import { QQBot, type MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { GatewayError, GatewayErrorCode, RECONNECT_DELAYS } from '@tencent-connect/qqbot-nodejs/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { once } from 'node:events';
import type { PaseoApi, PaseoAgentStream } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey } from './state.ts';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

it('disable settles the owned QQ route before a native send acknowledgement without stopping the agent', async () => {
  const values = StateSchema.parse({ config: { appId: 'test-account' } });
  const storage = { get: async () => ({ revision: 0, values: structuredClone(values) }), patch: vi.fn() } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const scope = createActivationScope(2);
  const installation: PluginInstallation = { id: 'installation', packageId: packageMetadata.name, owner: 'daemon', version: packageMetadata.version, generation: scope.generation, enabled: true, declaredCapabilities: packageMetadata.ompDesktop.capabilities, grantedCapabilities: packageMetadata.ompDesktop.capabilities };
  const context = { signal: scope.signal, installation, paseo: {} } as unknown as PluginServiceContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gateway = new Gateway(context, store, new Pairing(store), values.config, 'fixture-only-secret', logger, vi.fn());
  const acknowledged = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const agent = { send: vi.fn(() => { sent.resolve(); return acknowledged.promise; }), stop: vi.fn() };
  const paseo = createPluginPaseoApi({ agents: { ref: () => agent } } as unknown as PaseoApi, installation, scope, { mode: 'active' });
  const route = { peer: { appId: 'test-account', scope: 'c2c', openid: 'peer', cwd: '/workspace' }, agent: paseo.agents.ref('agent'), pending: new Map() };
  const internal = gateway as unknown as { routes: Map<string, typeof route>; getOrCreate: () => Promise<typeof route>; message: (context: MiddlewareContext) => Promise<void> };
  vi.spyOn(internal, 'getOrCreate').mockResolvedValue(route);
  internal.routes.set(peerKey('test-account','c2c','peer'),route);
  const message = { replyTarget: { scope: 'c2c', targetId: 'peer', msgId: 'message' }, message: { kind: 'c2c', content: 'hello', senderId: 'peer' }, state: {} } as unknown as MiddlewareContext;
  const work = internal.message(message);
  const settled = work.then(() => null, error => error);
  try {
    await Promise.race([sent.promise, work]);
    gateway.dispose();
    const result = await Promise.race([settled, new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('QQ 路由取消');
    expect(agent.stop).not.toHaveBeenCalled();
  } finally {
    gateway.dispose();
    acknowledged.resolve();
    await settled;
    vi.restoreAllMocks();
    await scope.dispose();
  }
});

it('newer native tool metadata preserves inspected MIME and delivers extensionless image artifacts', async () => {
  const values = StateSchema.parse({ config: { appId: 'test-account', sendFile: { sendPresentedFiles: true } } });
  const storage = { get: async () => ({ revision: 0, values: structuredClone(values) }), patch: vi.fn() } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const context = { signal: new AbortController().signal, installation: { id: 'installation', generation: 2 }, paseo: {} } as unknown as PluginServiceContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gateway = new Gateway(context, store, new Pairing(store), values.config, 'fixture-only-secret', logger, vi.fn());
  const route = { peer: { appId: 'test-account', scope: 'c2c' as const, openid: 'peer', agentId: 'agent' }, enabledDelivery: true, target: { scope: 'c2c', targetId: 'peer' }, buffer: null, files: new Map<string, {name:string;mimeType?:string}>(), toolRevisions: new Map(), pending: new Map(), lastSeq: 0 };
  const internal = gateway as unknown as { routes: Map<string, typeof route>; event: (route: typeof route, stream: PaseoAgentStream) => Promise<void>; deliverFile: (...args: unknown[]) => Promise<void> };
  internal.routes.set(peerKey('test-account', 'c2c', 'peer'), route);
  const delivered = vi.spyOn(internal, 'deliverFile').mockResolvedValue();
  try {
    const item = { type: 'tool_call', callId: 'present', name: 'present_image', status: 'completed', revision: 0 };
    await internal.event(route, { seq: 1, contentVersion: 1, event: { type: 'timeline', item } } as unknown as PaseoAgentStream);
    await internal.event(route, { seq: 1, contentVersion: 2, event: { type: 'timeline', item: { ...item, metadata: { presentedFilesSource: 'omp-present-image', presentedFiles: [{ path: '/workspace/extensionless', name: 'Inspected image', mimeType: 'image/png' }] } } } } as unknown as PaseoAgentStream);
    expect(route.files.get('/workspace/extensionless')).toEqual({ name: 'Inspected image', mimeType: 'image/png' });
    await internal.event(route, { seq: 2, event: { type: 'turn_completed' } } as unknown as PaseoAgentStream);
    expect(delivered).toHaveBeenCalledWith(route, '/workspace/extensionless', 'image', { scope: 'c2c', targetId: 'peer' });
  } finally {
    gateway.dispose();
    vi.restoreAllMocks();
  }
});

it.each([false, true])('failed tool events stay internal while the final reply still reaches QQ (showToolResults=%s)', async showToolResults => {
  const values = StateSchema.parse({ config: { appId: 'test-account', showToolResults, streaming: false } });
  const storage = { get: async () => ({ revision: 0, values: structuredClone(values) }), patch: vi.fn() } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const context = { signal: new AbortController().signal, installation: { id: 'installation', generation: 2 }, paseo: {} } as unknown as PluginServiceContext;
  const gateway = new Gateway(context, store, new Pairing(store), values.config, 'fixture-only-secret', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
  const route = { peer: { appId: 'test-account', scope: 'c2c' as const, openid: 'peer', agentId: 'agent' }, enabledDelivery: true, target: { scope: 'c2c', targetId: 'peer' }, buffer: null, files: new Map(), textRows: new Map(), toolRevisions: new Map(), pending: new Map(), lastSeq: 0 };
  const internal = gateway as unknown as { routes: Map<string, typeof route>; event: (route: typeof route, stream: PaseoAgentStream) => Promise<void>; sender: { sendMarkdown: (target: unknown, text: string) => Promise<void> } };
  internal.routes.set(peerKey('test-account', 'c2c', 'peer'), route);
  const sent = vi.spyOn(internal.sender, 'sendMarkdown').mockResolvedValue();
  try {
    const failed = { type: 'tool_call', callId: 'fetch', name: 'sandbox_fetch', status: 'failed', revision: 1 };
    await internal.event(route, { seq: 1, event: { type: 'timeline', item: failed } } as unknown as PaseoAgentStream);
    await internal.event(route, { seq: 1, contentVersion: 2, event: { type: 'timeline', item: { ...failed, revision: 2 } } } as unknown as PaseoAgentStream);
    expect(sent).not.toHaveBeenCalled();
    await internal.event(route, { seq: 2, event: { type: 'timeline', item: { type: 'assistant_message', text: '这是查询结果。' } } } as unknown as PaseoAgentStream);
    await internal.event(route, { seq: 3, event: { type: 'turn_completed' } } as unknown as PaseoAgentStream);
    expect(sent).toHaveBeenCalledExactlyOnceWith({ scope: 'c2c', targetId: 'peer' }, '这是查询结果。');
  } finally {
    gateway.dispose();
    vi.restoreAllMocks();
  }
});

function connectionFixture() {
  const values = StateSchema.parse({ config: { appId: 'test-account' } });
  const storage = { get: async () => ({ revision: 0, values: structuredClone(values) }), patch: vi.fn() } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const context = { signal: new AbortController().signal, installation: { id: 'installation', generation: 2 }, paseo: {} } as unknown as PluginServiceContext;
  const changed = vi.fn();
  const gateway = new Gateway(context, store, new Pairing(store), values.config, 'fixture-only-secret', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, changed);
  const internal = gateway as unknown as { bot: QQBot; sandboxRoot: () => Promise<string> };
  vi.spyOn(internal, 'sandboxRoot').mockResolvedValue('/qqbot-connection-fixture');
  // Drive the SDK's private emitter only at this lifecycle test seam.
  const events = internal.bot as unknown as { emit: (event: string, data: unknown) => Promise<void> };
  const emit = (event: 'ready'|'resumed'|'disconnected', data: unknown) => events.emit(event, data);
  return { gateway, bot: internal.bot, changed, emit };
}

it.each([0, 9])('SDK protocol returns to ready with RESUMED after %i failed reconnect requests', async failures => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local WebSocket address missing');
  let remainingFailures = 0;
  let reconnectRequests = 0;
  let established = 0;
  let firstSocket: WebSocket | undefined;
  let lastSocket: WebSocket | undefined;
  const handshakes: number[] = [];
  server.on('connection', socket => {
    firstSocket ??= socket;
    lastSocket = socket;
    socket.on('message', raw => {
      const payload = JSON.parse(raw.toString());
      if (payload.op !== 2 && payload.op !== 6) return;
      handshakes.push(payload.op);
      established++;
      socket.send(JSON.stringify({ op: 0, t: payload.op === 6 ? 'RESUMED' : 'READY', s: established, d: { session_id: 'local-session' } }));
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/app/getAppAccessToken')) return Response.json({ access_token: 'local-token', expires_in: 7200 });
    if (url.endsWith('/gateway')) {
      if (established) reconnectRequests++;
      if (remainingFailures-- > 0) return Response.json({ message: 'local simulated outage' }, { status: 503 });
      return Response.json({ url: `ws://127.0.0.1:${address.port}` });
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  }));
  const f = connectionFixture();
  const started = vi.spyOn(f.bot, 'start');
  // Preserve the production retry budget while making only its delays immediate.
  const sdk = f.bot as unknown as { opts: { reconnect?: { maxAttempts?: number; delays?: readonly number[] } } };
  sdk.opts.reconnect = { ...sdk.opts.reconnect, delays: [0] };
  const ready = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  f.bot.on('ready', () => ready.resolve());
  f.bot.on('resumed', () => resumed.resolve());
  f.bot.on('disconnected', () => disconnected.resolve());
  try {
    await f.gateway.start();
    const running = started.mock.results[0]!.value;
    await Promise.race([ready.promise, running]);
    expect(f.changed).toHaveBeenLastCalledWith('ready');
    remainingFailures = failures;
    firstSocket!.terminate();
    await disconnected.promise;
    expect(f.changed).toHaveBeenLastCalledWith('connecting', expect.any(String));
    await Promise.race([resumed.promise, running]);
    expect(established).toBe(2);
    expect(handshakes).toEqual([2, 6]);
    expect(reconnectRequests).toBe(failures + 1);
    expect(f.changed).toHaveBeenLastCalledWith('ready');
    const closed = once(lastSocket!, 'close');
    f.gateway.dispose();
    const changes = f.changed.mock.calls.length;
    await f.emit('resumed', {});
    await closed;
    expect(established).toBe(2);
    expect(f.changed).toHaveBeenCalledTimes(changes);
  } finally {
    f.gateway.dispose();
    for (const socket of server.clients) socket.terminate();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it.each(['network', 429, 503] as const)('initial SDK token failure retries beyond eight attempts: %s', async failure => {
  vi.useFakeTimers();
  const f = connectionFixture();
  const started = vi.spyOn(f.bot, 'start');
  const gatewayResponse = Promise.withResolvers<Response>();
  let tokenRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/app/getAppAccessToken')) {
      if (++tokenRequests <= 9) {
        if (failure === 'network') throw new TypeError('fetch failed');
        return Response.json({ message: 'local simulated outage' }, { status: failure });
      }
      return Response.json({ access_token: 'local-token', expires_in: 7200 });
    }
    if (url.endsWith('/gateway')) return gatewayResponse.promise;
    throw new Error(`Unexpected test fetch: ${url}`);
  }));
  try {
    await f.gateway.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 9; attempt++) await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]!);
    expect(started).toHaveBeenCalledTimes(10);
    expect(tokenRequests).toBe(10);
    expect(f.bot.tokenManager.getStatus('test-account').status).toBe('valid');
    expect(f.changed).toHaveBeenLastCalledWith('connecting');
  } finally {
    f.gateway.dispose();
    gatewayResponse.resolve(Response.json({ url: 'ws://127.0.0.1:1' }));
    await vi.advanceTimersByTimeAsync(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it.each([new GatewayError('banned', GatewayErrorCode.FATAL_CLOSE, 4915), new GatewayError('offline/sandbox-only', GatewayErrorCode.FATAL_CLOSE, 4914), new Error('Token fetch failed: HTTP 401'), new Error('Failed to get access_token: {"code":400}')])('terminal startup errors wait for explicit restart: %s', async error => {
  vi.useFakeTimers();
  const f = connectionFixture();
  const started = vi.spyOn(f.bot, 'start').mockRejectedValue(error);
  try {
    await f.gateway.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(started).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenLastCalledWith('failed', error.message);
  } finally {
    f.gateway.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it('disable cancels initial token retries and ignores late lifecycle events', async () => {
  vi.useFakeTimers();
  const f = connectionFixture();
  const started = vi.spyOn(f.bot, 'start').mockRejectedValue(new Error('Network error getting access_token: fetch failed'));
  try {
    await f.gateway.start();
    await vi.advanceTimersByTimeAsync(0);
    f.gateway.dispose();
    const changes = f.changed.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    await f.emit('ready', {});
    await f.emit('resumed', {});
    await f.emit('disconnected', { code: 1006, reason: 'late close', willReconnect: true });
    expect(started).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(changes);
  } finally {
    f.gateway.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

// ACK delivery is real socket I/O; advancing protocol timers before processing
// those packets would manufacture a missed ACK. The idle-clock jump is isolated.
async function heartbeatFixture(acknowledge: boolean) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local WebSocket address missing');
  let connections = 0;
  let heartbeats = 0;
  const handshakes: number[] = [];
  const firstHeartbeat = Promise.withResolvers<void>();
  const firstSocketClosed = Promise.withResolvers<void>();
  server.on('connection', socket => {
    const connection = ++connections;
    if (connection === 1) socket.once('close', () => firstSocketClosed.resolve());
    socket.on('message', raw => {
      const payload = JSON.parse(raw.toString());
      if (payload.op === 1) {
        heartbeats++;
        if (acknowledge || connection > 1) socket.send(JSON.stringify({ op: 11 }));
        firstHeartbeat.resolve();
      } else if (payload.op === 2 || payload.op === 6) {
        handshakes.push(payload.op);
        if (connection > 1) {
          expect(payload.d.session_id).toBe('heartbeat-session');
          expect(payload.d.seq).toBe(1);
        }
        socket.send(JSON.stringify({ op: 0, t: connection === 1 ? 'READY' : 'RESUMED', s: connection, d: { session_id: 'heartbeat-session' } }));
      }
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }));
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/app/getAppAccessToken')) return Response.json({ access_token: 'local-token', expires_in: 7200 });
    if (url.endsWith('/gateway')) return Response.json({ url: `ws://127.0.0.1:${address.port}` });
    throw new Error(`Unexpected test fetch: ${url}`);
  }));
  const f = connectionFixture();
  const started = vi.spyOn(f.bot, 'start');
  const ready = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const disconnects: string[] = [];
  f.bot.on('ready', () => ready.resolve());
  f.bot.on('resumed', () => resumed.resolve());
  f.bot.on('disconnected', event => { disconnects.push(event.reason); });
  return {
    ...f, server, firstHeartbeat, firstSocketClosed, resumed, handshakes, disconnects,
    connections: () => connections,
    heartbeats: () => heartbeats,
    start: async () => {
      await f.gateway.start();
      await Promise.race([ready.promise, started.mock.results[0]!.value]);
    },
    close: async () => {
      f.gateway.dispose();
      for (const socket of server.clients) socket.terminate();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    },
  };
}

it('missing heartbeat ACK retires a half-open QQ socket and resumes the existing session', async () => {
  const f = await heartbeatFixture(false);
  try {
    await f.start();
    await f.resumed.promise;
    expect(f.connections()).toBe(2);
    expect(f.handshakes).toEqual([2, 6]);
    expect(f.disconnects).toEqual(['Heartbeat ACK timed out']);
    expect(f.changed).toHaveBeenCalledWith('connecting', 'Heartbeat ACK timed out');
    expect(f.changed).toHaveBeenLastCalledWith('ready');
  } finally { await f.close(); }
});

it('idle QQ sockets with acknowledged heartbeats stay connected without application messages', async () => {
  const f = await heartbeatFixture(true);
  try {
    await f.start();
    await vi.waitFor(() => expect(f.heartbeats()).toBeGreaterThanOrEqual(4));
    expect(f.connections()).toBe(1);
    expect(f.handshakes).toEqual([2]);
    expect(f.disconnects).toEqual([]);
    expect(f.changed).toHaveBeenLastCalledWith('ready');
  } finally { await f.close(); }
});

it('a delayed heartbeat after long idle resumes QQ without losing session identity', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = await heartbeatFixture(true);
  try {
    await f.start();
    await f.firstHeartbeat.promise;
    vi.setSystemTime(Date.now() + 60_000);
    await f.resumed.promise;
    expect(f.connections()).toBe(2);
    expect(f.handshakes).toEqual([2, 6]);
    expect(f.disconnects).toEqual(['Heartbeat stalled after idle']);
    expect(f.changed).toHaveBeenCalledWith('connecting', 'Heartbeat stalled after idle');
    expect(f.changed).toHaveBeenLastCalledWith('ready');
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

it('disable cancels an outstanding QQ heartbeat ACK timeout without reopening the socket', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const f = await heartbeatFixture(false);
  try {
    await f.start();
    await vi.advanceTimersByTimeAsync(100);
    await f.firstHeartbeat.promise;
    f.gateway.dispose();
    const changes = f.changed.mock.calls.length;
    await f.firstSocketClosed.promise;
    await vi.advanceTimersByTimeAsync(250);
    expect(f.server.clients.size).toBe(0);
    expect(f.connections()).toBe(1);
    expect(f.handshakes).toEqual([2]);
    expect(f.disconnects).toEqual([]);
    expect(f.changed).toHaveBeenCalledTimes(changes);
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

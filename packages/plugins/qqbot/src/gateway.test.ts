import { expect, it, vi } from 'vitest';
import type { PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { PaseoAgentStream } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey } from './state.ts';

it('disable settles the owned QQ route before a native send acknowledgement without stopping the agent', async () => {
  const values = StateSchema.parse({ config: { appId: 'test-account' } });
  const storage = { get: async () => ({ revision: 0, values: structuredClone(values) }), patch: vi.fn() } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const controller = new AbortController();
  const context = { signal: controller.signal, installation: { id: 'installation', generation: 2 }, paseo: {} } as unknown as PluginServiceContext;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gateway = new Gateway(context, store, new Pairing(store), values.config, 'fixture-only-secret', logger, vi.fn());
  const acknowledged = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  const agent = { send: vi.fn(() => { sent.resolve(); return acknowledged.promise; }), stop: vi.fn() };
  const route = { peer: { scope: 'c2c', openid: 'peer', cwd: '/workspace' }, agent, pending: new Map() };
  const internal = gateway as unknown as { getOrCreate: () => Promise<typeof route>; message: (context: MiddlewareContext) => Promise<void> };
  vi.spyOn(internal, 'getOrCreate').mockResolvedValue(route);
  const message = { replyTarget: { scope: 'c2c', targetId: 'peer', msgId: 'message' }, message: { kind: 'c2c', content: 'hello', senderId: 'peer' }, state: {} } as unknown as MiddlewareContext;
  const work = internal.message(message);
  const settled = work.then(() => null, error => error);
  await sent.promise;
  gateway.dispose();
  try {
    const result = await Promise.race([settled, new Promise<null>(resolve => setImmediate(() => resolve(null)))]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('QQ 路由取消');
    expect(agent.stop).not.toHaveBeenCalled();
  } finally {
    acknowledged.resolve();
    await settled;
    vi.restoreAllMocks();
  }
});

it('newer native tool metadata preserves inspected MIME and delivers extensionless image artifacts', async () => {
  const values = StateSchema.parse({ config: { appId: 'test-account' } });
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

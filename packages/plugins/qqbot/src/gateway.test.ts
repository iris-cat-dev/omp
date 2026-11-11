import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createActivationScope, createPluginPaseoApi } from '@omp-desktop/plugin/server';
import type { PluginInstallation, PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
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

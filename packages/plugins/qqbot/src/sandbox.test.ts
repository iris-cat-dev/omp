import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createActivationScope, createPluginPaseoApi } from '@omp-desktop/plugin/server';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import type * as Os from 'node:os';
import { join, parse } from 'node:path';
import type { PluginInstallation, PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import type { PaseoApi, PaseoAgentHandle, PaseoAgentCreateOptions, PaseoAgentObservation, PaseoAgentStream } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, peerKey, type Peer } from './state.ts';

const isolatedHome = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof Os>();
  return { ...actual, homedir: () => isolatedHome.path ?? actual.homedir() };
});
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); isolatedHome.path=null;vi.restoreAllMocks(); });


const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
async function fixture(sandboxPath?: string, provider = 'omp', presentedFiles = false) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-sandbox-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = await realpath(directory);
  const key = peerKey('saved-app', 'c2c', 'peer');
  let values = StateSchema.parse({ config: { appId: 'saved-app', sandboxPath: sandboxPath ?? root, sendFile: { sendPresentedFiles: presentedFiles, extraRoots: ['/outside'] }, presets: [{ name: 'default', config: { provider, modeId: 'full', thinkingOptionId: 'high', systemPrompt: 'Keep prompt' }, qq: { prompt: 'QQ context' } }] }, modelSelections: { [key]: 'provider/model' }, credentialVersions: { 'saved-app': 1 } });
  let revision = 0;
  const storage = { get: async () => ({ revision, values: structuredClone(values) }), patch: async (patch: unknown, expected: number) => { if (expected !== revision) throw new Error('STORAGE_REVISION_CONFLICT'); values = StateSchema.parse(patch); return { revision: ++revision, values }; } } as unknown as PluginStorage;
  const store = new StateStore(storage);
  const old = { id: 'old-agent', stop: vi.fn(async () => {}), refresh: vi.fn(async () => ({ agent: { id: 'old-agent', sandbox: undefined } })) };
  const unsubscribe = vi.fn();
  const fresh = { id: 'new-agent', stop: vi.fn(async () => {}), observe: vi.fn(async () => ({ snapshot: { sandbox: { root }, pendingPermissions: [], activeTurn: null }, timeline: { window: { maxSeq: 0 }, entries: [] }, unsubscribe } as unknown as PaseoAgentObservation)) };
  const create = vi.fn(async (_options: PaseoAgentCreateOptions) => fresh as unknown as PaseoAgentHandle);
  const open = vi.fn(async (_path: string) => ({ id: 'workspace', agents: { create } }));
  const native = { invoke: vi.fn(async (_operation: string, input: unknown):Promise<unknown> => { if(!input||typeof input!=='object'||!('action' in input))throw new Error('Missing native action');if(input.action==='open')return{handle:'pinned-handle'};if(input.action==='close')return{ok:true};if(input.action==='read')return{contentBase64:Buffer.from('inside-media').toString('base64')};throw new Error(`Unexpected native action: ${String(input.action)}`); }) };
  const scope = createActivationScope(1);
  cleanups.push(() => scope.dispose());
  const installation: PluginInstallation = { id: 'installation', packageId: packageMetadata.name, owner: 'daemon', version: packageMetadata.version, generation: scope.generation, enabled: true, declaredCapabilities: packageMetadata.ompDesktop.capabilities, grantedCapabilities: packageMetadata.ompDesktop.capabilities };
  const paseo = createPluginPaseoApi({ hostId: 'host', agents: { ref: vi.fn(() => old) }, workspaces: { open } } as unknown as PaseoApi, installation, scope, { mode: 'active' });
  const ctx = { signal: scope.signal, installation, native, paseo } as unknown as PluginServiceContext;
  const gateway = new Gateway(ctx, store, new Pairing(store), values.config, 'fixture-secret', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
  cleanups.push(() => gateway.dispose());
  const internal = gateway as unknown as { getOrCreate(scope: 'c2c' | 'group', openid: string, reset?: boolean): Promise<{ peer: Peer; agent: PaseoAgentHandle }>; routes: Map<string, unknown>; event(route: unknown, stream: PaseoAgentStream): Promise<void>; deliverFile(route:unknown,path:string,type:string,target:unknown):Promise<void>; sender: { sendMarkdown: (...args: unknown[]) => Promise<unknown> }; bot: { sendImage:(...args:unknown[])=>Promise<unknown>;apiClient: { request: (...args: unknown[]) => Promise<unknown> } }; deliveryRoute: { run<T>(route: unknown, callback: () => T): T } };
  const saved = (sandbox?: { root: string }): Peer => ({ appId: 'saved-app', scope: 'c2c', openid: 'peer', hostId: 'host', workspaceId: 'old-workspace', agentId: old.id, cwd: sandbox?.root ?? root, sandbox, preset: 'default', template: values.config.presets[0]!, protocolPrompt: 'Old QQ context', lastDeliveredSequence: 4 });
  return { root, key, store, old, fresh, create, open, internal, gateway, unsubscribe, saved, native };
}

it('creates mandatory sandbox with safe approval while preserving saved model and prompts', async () => {
  const f = await fixture();
  const route = await f.internal.getOrCreate('c2c', 'peer');
  expect(f.open).toHaveBeenCalledWith(f.root);
  expect(f.create.mock.calls[0]?.[0].config).toMatchObject({ cwd: f.root, sandbox: { root: f.root }, modeId: 'ask', provider: 'omp/provider/model', thinkingOptionId: 'high' });
  expect(f.create.mock.calls[0]?.[0].config?.systemPrompt).toContain('Keep prompt');
  expect(f.create.mock.calls[0]?.[0].config?.systemPrompt).toContain('QQ context');
  expect(f.create.mock.calls[0]?.[0].config?.systemPrompt).not.toContain(f.root);
  expect(route.peer.sandbox).toEqual({ root: f.root });
  await expect(f.gateway.sendFile(route.peer.agentId, '../outside', 'file')).rejects.toThrow('qqbot_send_file');
});

it.each(['legacy', 'moved-root', 'unsupported-agent'] as const)('stops %s peer before replacement without deleting its history', async kind => {
  const f = await fixture();
  const peer = f.saved(kind === 'legacy' ? undefined : { root: kind === 'moved-root' ? join(f.root, 'old') : f.root });
  await f.store.mutate(state => { state.peers[f.key] = peer; });
  const stopped = Promise.withResolvers<void>();
  f.old.stop.mockImplementation(() => stopped.promise);
  const work = f.internal.getOrCreate('c2c', 'peer');
  await vi.waitFor(() => expect(f.old.stop).toHaveBeenCalledOnce());
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.read()).values.peers[f.key]?.agentId).toBe('old-agent');
  stopped.resolve();
  expect((await work).peer.agentId).toBe('new-agent');
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});

it('does not create a replacement if stopping the old agent fails', async () => {
  const f = await fixture();
  await f.store.mutate(state => { state.peers[f.key] = f.saved(); });
  f.old.stop.mockRejectedValue(new Error('stop failed'));
  await expect(f.internal.getOrCreate('c2c', 'peer')).rejects.toThrow('stop failed');
  expect(f.create).not.toHaveBeenCalled();
});

it('stops a stale create after root change and never stores or attaches it', async () => {
  const f = await fixture();
  const created = Promise.withResolvers<PaseoAgentHandle>();
  const called = Promise.withResolvers<void>();
  f.create.mockImplementation(() => { called.resolve(); return created.promise; });
  const work = f.internal.getOrCreate('c2c', 'peer');
  const settled = work.catch(error => error);
  await called.promise;
  await f.store.mutate(state => { state.config.sandboxPath = join(f.root, 'next'); });
  created.resolve(f.fresh as unknown as PaseoAgentHandle);
  expect(await settled).toBeInstanceOf(Error);
  expect(f.fresh.stop).toHaveBeenCalled();
  expect(f.fresh.observe).not.toHaveBeenCalled();
  expect((await f.store.read()).values.peers[f.key]).toBeUndefined();
  expect(f.internal.routes.size).toBe(0);
});

it('rejects unconfirmed sandbox observation instead of reusing the route', async () => {
  const f = await fixture();
  f.fresh.observe.mockResolvedValue({ snapshot: { pendingPermissions: [], activeTurn: null }, timeline: { window: { maxSeq: 0 }, entries: [] }, unsubscribe: f.unsubscribe } as unknown as PaseoAgentObservation);
  await expect(f.internal.getOrCreate('c2c', 'peer')).rejects.toThrow('未确认');
  expect(f.fresh.stop).toHaveBeenCalled();
  expect(f.unsubscribe).toHaveBeenCalled();
  expect(f.internal.routes.size).toBe(0);
});

it('blocks retired route events and SDK retry HTTP requests', async () => {
  const f = await fixture();
  const route = await f.internal.getOrCreate('c2c', 'peer');
  f.internal.routes.delete(f.key);
  const send = vi.spyOn(f.internal.sender, 'sendMarkdown');
  await f.internal.event(route, { event: { type: 'turn_failed', error: 'HOST_SECRET' } } as unknown as PaseoAgentStream);
  expect(send).not.toHaveBeenCalled();
  await expect(f.internal.deliveryRoute.run(route, () => f.internal.bot.apiClient.request('token', 'POST', '/v2/users/peer/messages', {}))).rejects.toThrow('generation');
});

it('blocks stale old-root delivery immediately after storage changes', async () => {
  const f = await fixture();
  const route = await f.internal.getOrCreate('c2c', 'peer');
  await f.store.mutate(state => { state.config.sandboxPath = join(f.root, 'next'); });
  const send = vi.spyOn(f.internal.sender, 'sendMarkdown');
  await f.internal.event(route, { event: { type: 'turn_failed', error: 'HOST_SECRET' } } as unknown as PaseoAgentStream);
  expect(send).not.toHaveBeenCalled();
  await expect(f.internal.bot.apiClient.request('token', 'POST', '/v2/users/peer/messages', {})).rejects.toThrow('沙箱配置');
});

it('rejects filesystem root and user home as sandbox roots', async () => {
  const f = await fixture();
  for (const broad of [homedir(), parse(f.root).root]) {
    await f.store.mutate(s => { s.config.sandboxPath = broad; });
    const config = (await f.store.read()).values.config;
    const ctx = { signal: new AbortController().signal, installation: { id: 'installation', generation: 1 }, paseo: {} } as unknown as PluginServiceContext;
    const gateway = new Gateway(ctx, f.store, new Pairing(f.store), config, 'fixture-secret', { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }, vi.fn());
    cleanups.push(() => gateway.dispose());
    await expect(gateway.start()).rejects.toThrow('根目录或用户主目录');
  }
});

it('blank path creates a dedicated private directory in an isolated home', async () => {
  const f=await fixture('');isolatedHome.path=f.root;
  const expected=join(f.root,'.omp','qqbot-sandbox','installation');
  f.fresh.observe.mockResolvedValue({snapshot:{sandbox:{root:expected},pendingPermissions:[],activeTurn:null},timeline:{window:{maxSeq:0},entries:[]},unsubscribe:f.unsubscribe} as unknown as PaseoAgentObservation);
  const route=await f.internal.getOrCreate('c2c','peer');
  expect(route.peer.sandbox?.root).toBe(expected);
  expect(f.open).toHaveBeenCalledWith(expected);
  expect((await stat(expected)).mode&0o077).toBe(0);
  expect(f.native.invoke).toHaveBeenCalledWith('files.sandbox',{action:'open',root:expected,maxBytes:200*1024*1024});
});

it('rejects unsupported providers before create rather than letting them ignore sandbox', async () => {
  const f=await fixture(undefined,'codex');
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('仅支持 OMP');
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.read()).values.config.appId).toBe('saved-app');
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});

it('uploads only pinned byte snapshots and ignores outside extraRoots', async () => {
  const f=await fixture(undefined,'omp',true);
  const route=await f.internal.getOrCreate('c2c','peer');
  const send=vi.spyOn(f.internal.bot,'sendImage').mockResolvedValue({});
  await f.internal.deliverFile(route,`${f.root}/inside.png`,'image',{scope:'c2c',targetId:'peer'});
  expect(send.mock.calls[0]?.[1]).toEqual({buffer:Buffer.from('inside-media')});
  await expect(f.internal.deliverFile(route,'/outside/private.png','image',{scope:'c2c',targetId:'peer'})).rejects.toThrow('沙箱内');
  expect(send).toHaveBeenCalledOnce();
});

it('presented file uploads require explicit opt-in', async () => {
  const f=await fixture();const route=await f.internal.getOrCreate('c2c','peer');
  const send=vi.spyOn(f.internal.bot,'sendImage').mockResolvedValue({});
  await expect(f.internal.deliverFile(route,`${f.root}/inside.png`,'image',{scope:'c2c',targetId:'peer'})).rejects.toThrow('未开启');
  expect(send).not.toHaveBeenCalled();
});

it('root change prevents a late model acknowledgement from overwriting peer preference', async () => {
  const f=await fixture();await f.internal.getOrCreate('c2c','peer');
  const called=Promise.withResolvers<void>();const acknowledged=Promise.withResolvers<void>();
  Object.assign(f.fresh,{setModel:vi.fn(()=>{called.resolve();return acknowledged.promise;})});
  const internal=f.gateway as unknown as {command(context:unknown,text:string):Promise<void>};
  const work=internal.command({replyTarget:{scope:'c2c',targetId:'peer'},message:{senderId:'peer'}},'/model provider/new-model');
  const settled=work.catch(error=>error);await called.promise;
  await f.store.mutate(s=>{s.config.sandboxPath=join(f.root,'next');});acknowledged.resolve();
  expect(await settled).toBeInstanceOf(Error);
  expect((await f.store.read()).values.modelSelections[f.key]).toBe('provider/model');
});

it('unavailable pinned filesystem stops QQ creation without falling back to host files', async () => {
  const f=await fixture();f.native.invoke.mockRejectedValueOnce(new Error('unsupported secure filesystem'));
  await expect(f.internal.getOrCreate('c2c','peer')).rejects.toThrow('unsupported secure filesystem');
  expect(f.create).not.toHaveBeenCalled();expect(f.internal.routes.size).toBe(0);
});

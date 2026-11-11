import { describe, expect, it } from 'vitest';
import type { PluginStorage } from '@omp-desktop/plugin';
import { StateSchema, ConfigSchema, AgentPresetSchema, StateStore, Pairing, switchAccount, peerKey, permitted } from './state.ts';
function memoryStorage(): PluginStorage { let revision=0;let values:Record<string,unknown>={};return {async get<T>(){return{revision,values:structuredClone(values) as T};},async patch<T>(patch:Partial<T>,expected:number){if(expected!==revision)throw new Error('STORAGE_REVISION_CONFLICT');values={...values,...structuredClone(patch)};return{revision:++revision,values:structuredClone(values) as T};}}; }
describe('QQ scoped state',()=>{
  it('keys mapping by AppID, scope and OpenID without assigning DSH IDs',()=>{expect(peerKey('a','c2c','same')).not.toBe(peerKey('a','group','same'));expect(peerKey('a','c2c','same')).not.toBe(peerKey('b','c2c','same'));});
  it('empty allowlist and disabled access deny while open access admits',()=>{expect(permitted('allowlist',[],'sender')).toBe(false);expect(permitted('disabled',[],'sender')).toBe(false);expect(permitted('open',[],'sender')).toBe(true);});
  it('switching bot accounts preserves original lists without authorizing them on another account',()=>{const state=StateSchema.parse({config:{appId:'first'},access:{owners:[{openid:'owner-first',scene:'c2c',claimedAt:1}]}});switchAccount(state,'second');expect(state.access.owners).toEqual([]);switchAccount(state,'first');expect(state.access.owners[0]?.openid).toBe('owner-first');});
  it('rejects stale access edits without replacing latest members',async()=>{const store=new StateStore(memoryStorage());await store.mutate(s=>{s.access.revision++;s.access.owners.push({openid:'latest',nickname:'',scene:'c2c',sceneName:'',claimedAt:1});},0);await expect(store.mutate(s=>{s.access.owners=[];},0)).rejects.toThrow('ACCESS_REVISION_CONFLICT');expect((await store.read()).values.access.owners[0]?.openid).toBe('latest');});
  it('preserves schema-valid named presets and rejects DSH service mounts and unsupported agent options',()=>{expect(AgentPresetSchema.parse({name:'coding',config:{provider:'omp/provider/model',toolPolicy:{preapproved:[]}},qq:{skills:['code-review'],tools:['qqbot_send_file']}}).name).toBe('coding');expect(()=>AgentPresetSchema.parse({name:'dsh',config:{provider:'omp',services:['cordis-model']}})).toThrow();expect(()=>ConfigSchema.parse({presets:[{name:'duplicate',config:{provider:'omp'}},{name:'duplicate',config:{provider:'omp'}}],defaultPreset:'duplicate'})).toThrow();});
  it('pair claims are reusable for a batch, idempotent per identity, and revision-aware',async()=>{const store=new StateStore(memoryStorage());await store.mutate(s=>{s.config.appId='bot';});const pairing=new Pairing(store);const challenge=await pairing.issue('allow-group');await pairing.claim(challenge.code,'group','group-a','sender-a','Alpha');await pairing.claim(challenge.code,'group','group-a','sender-b','Alpha');await pairing.claim(challenge.code,'group','group-b','sender-b','Beta');expect(challenge.claims).toHaveLength(2);expect((await store.read()).values.access.allowGroup).toHaveLength(2);await expect(pairing.manual('owner','owner:Name',0)).rejects.toThrow('ACCESS_REVISION_CONFLICT');pairing.clear();expect(pairing.active(challenge.code)).toBeUndefined();});
  it('cannot claim an invitation after bot replacement or invite revocation',async()=>{const store=new StateStore(memoryStorage());await store.mutate(s=>{s.config.appId='bot-one';});const pairing=new Pairing(store);const challenge=await pairing.issue('owner');await store.mutate(s=>switchAccount(s,'bot-two'));await expect(pairing.claim(challenge.code,'c2c','user','user','Name')).rejects.toThrow('账号已替换');expect((await store.read()).values.access.owners).toEqual([]);});
  it('expired pairing codes cannot write access or authorize a different scene',async()=>{
    const store=new StateStore(memoryStorage());
    await store.mutate(s=>{s.config.appId='offline-bot';});
    const pairing=new Pairing(store);
    const challenge=await pairing.issue('allow-group');
    await expect(pairing.claim(challenge.code,'c2c','sender','sender','Name')).rejects.toThrow('目标群');
    challenge.expiresAt=Date.now()-1;
    const before=await store.read();
    expect(await pairing.claim(challenge.code,'group','group','sender','Name')).toBe(false);
    expect(await store.read()).toEqual(before);
    expect(pairing.challenges.has(challenge.code)).toBe(false);
  });
});

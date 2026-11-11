import { afterEach, expect, it, vi } from 'vitest';
import type { PluginManagementContext, PluginServiceContext, PluginStorage } from '@omp-desktop/plugin/server';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import setup, { manage } from './service.ts';
import { Gateway } from './gateway.ts';
import { StateSchema } from './state.ts';
import { action, status, exportAccess } from './rpc.ts';
const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.useRealTimers();vi.restoreAllMocks();});
function fixture(role:'management'|'service'='management'){
  let revision=0;
  let values=StateSchema.parse({config:{appId:'local-account'},credentialVersions:{'local-account':0}});
  const secrets=new Map<string,string>([['app-secret:local-account:0','private-fixture-secret']]);
  const handlers=new Map<string,(input:any)=>any>();
  const controller=new AbortController();
  const storage:PluginStorage={async get<T>(){return{revision,values:structuredClone(values) as T};},async patch<T>(patch:Partial<T>,expected:number){if(expected!==revision)throw new Error('STORAGE_REVISION_CONFLICT');values=StateSchema.parse({...values,...patch});return{revision:++revision,values:structuredClone(values) as T};}};
  const context={installation:{id:'installation',packageId:'@omp-desktop/plugin-qqbot',owner:'daemon',version:'1.0.0',generation:9,enabled:role==='service',declaredCapabilities:[],grantedCapabilities:[]},signal:controller.signal,mode:role==='service'?'active':'manage',role,storage,secrets:{configured:async(key:string)=>secrets.has(key),get:async(key:string)=>secrets.get(key)??null,set:async(key:string,value:string)=>{secrets.set(key,value);},delete:async(key:string)=>{secrets.delete(key);}},handle:(contract:{name:string},handler:(input:any)=>any)=>handlers.set(contract.name,handler),own:(cleanup:()=>void)=>cleanup,waiting:vi.fn(),paseo:{}} as unknown as PluginManagementContext|PluginServiceContext;
  const cleanup=context.role==='service'?setup(context):manage(context);
  cleanups.push(cleanup);
  return{context,secrets,controller,read:()=>values,call:async(contract:{name:string;input:{parse:(v:unknown)=>unknown}},input:unknown)=>handlers.get(contract.name)!(contract.input.parse(input))};
}
it('disabled management declares actual routes without acquiring a QQ gateway or exposing AppSecret',async()=>{const started=vi.spyOn(QQBot.prototype,'start');const f=fixture();const result=await f.call(status,{});expect(result.connection).toBe('waiting');expect(result.secretConfigured).toBe(true);expect(JSON.stringify(result)).not.toContain('private-fixture-secret');expect(started).not.toHaveBeenCalled();await expect(f.call(action,{kind:'pair',purpose:'owner',accessRevision:0})).rejects.toThrow('启用');});
it('revision conflict leaves access and live credential unchanged',async()=>{const f=fixture();await f.call(action,{kind:'manual',purpose:'owner',text:'owner:Alice',accessRevision:0});f.secrets.set('credential-draft:11111111-1111-4111-8111-111111111111','new-secret');await expect(f.call(action,{kind:'replace',appId:'local-account',credentialKey:'credential-draft:11111111-1111-4111-8111-111111111111',accessRevision:0})).rejects.toThrow('ACCESS_REVISION_CONFLICT');expect(f.secrets.get('app-secret:local-account:0')).toBe('private-fixture-secret');expect(f.read().access.owners[0]?.nickname).toBe('Alice');});
it('management export is current-account revision checked and roundtrippable',async()=>{const f=fixture();await f.call(action,{kind:'manual',purpose:'owner',text:'owner:"Name, with punctuation"',accessRevision:0});await expect(f.call(exportAccess,{purpose:'owner',accessRevision:0})).rejects.toThrow('ACCESS_REVISION_CONFLICT');const result=await f.call(exportAccess,{purpose:'owner',accessRevision:1});expect(result.appId).toBe('local-account');expect(result.text).toBe('owner:"Name, with punctuation"');});
it('stopped management generations reject late mutations',async()=>{const f=fixture();f.controller.abort();await expect(f.call(action,{kind:'unbind',accessRevision:0})).rejects.toThrow('generation');expect(f.read().config.appId).toBe('local-account');});
it('successful credential activation commits an immutable version pointer',async()=>{const f=fixture();const key='credential-draft:11111111-1111-4111-8111-111111111111';f.secrets.set(key,'new-secret');const result=await f.call(action,{kind:'replace',appId:'local-account',credentialKey:key,accessRevision:0});expect(result.secretConfigured).toBe(true);expect(f.read().credentialVersions['local-account']).toBe(1);expect(f.secrets.get('app-secret:local-account:1')).toBe('new-secret');expect(f.secrets.get('app-secret:local-account:0')).toBe('private-fixture-secret');expect(f.secrets.has(key)).toBe(false);});
it('cancellation during secret staging cannot replace the previous active credential',async()=>{const f=fixture();const key='credential-draft:11111111-1111-4111-8111-111111111111';f.secrets.set(key,'new-secret');vi.spyOn(f.context.secrets,'set').mockImplementation(async(name,value)=>{f.secrets.set(name,value);f.controller.abort();});await expect(f.call(action,{kind:'replace',appId:'local-account',credentialKey:key,accessRevision:0})).rejects.toThrow('失效');expect(f.read().credentialVersions['local-account']).toBe(0);expect(f.secrets.get('app-secret:local-account:0')).toBe('private-fixture-secret');expect(f.read().access.revision).toBe(0);});
it('failed settings CAS never activates or overwrites a secret candidate',async()=>{const f=fixture();const key='credential-draft:11111111-1111-4111-8111-111111111111';f.secrets.set(key,'new-secret');vi.spyOn(f.context.storage,'patch').mockRejectedValueOnce(new Error('STORAGE_REVISION_CONFLICT'));await expect(f.call(action,{kind:'replace',appId:'local-account',credentialKey:key,accessRevision:0})).rejects.toThrow('STORAGE_REVISION_CONFLICT');expect(f.read().credentialVersions['local-account']).toBe(0);expect(f.secrets.get('app-secret:local-account:0')).toBe('private-fixture-secret');expect(f.secrets.has('app-secret:local-account:1')).toBe(false);});
it('import does not overwrite a newer peer preference written while credentials are resolved',async()=>{const f=fixture();const key='credential-draft:11111111-1111-4111-8111-111111111111';f.secrets.set(key,'import-secret');const peer='["local-account","c2c","peer"]';vi.spyOn(f.context.secrets,'get').mockImplementation(async name=>{if(name===key){const current=await f.context.storage.get();await f.context.storage.patch({modelSelections:{[peer]:'provider/newer-model'}},current.revision);}return f.secrets.get(name)??null;});await expect(f.call(action,{kind:'import',source:'dsh-qqbot',document:'appId: local-account',credentialKey:key,accessRevision:0})).rejects.toThrow('STORAGE_REVISION_CONFLICT');expect(f.read().modelSelections[peer]).toBe('provider/newer-model');expect(f.read().credentialVersions['local-account']).toBe(0);expect(f.secrets.get('app-secret:local-account:0')).toBe('private-fixture-secret');});

it('saving sandbox path through management preserves credentials, access and model preferences',async()=>{const f=fixture();await f.call(action,{kind:'manual',purpose:'owner',text:'owner:Alice',accessRevision:0});const stored=await f.context.storage.get();await f.context.storage.patch({modelSelections:{peer:'provider/model'}},stored.revision);const before=f.read();const result=await f.call(action,{kind:'configure',config:{...before.config,sandboxPath:'/dedicated-qq-root'},accessRevision:before.access.revision});expect(result.config.sandboxPath).toBe('/dedicated-qq-root');expect(result.appId).toBe('local-account');expect(result.secretConfigured).toBe(true);expect(f.secrets.get('app-secret:local-account:0')).toBe('private-fixture-secret');expect(f.read().access.owners).toEqual(before.access.owners);expect(f.read().modelSelections).toEqual(before.modelSelections);await expect(f.call(action,{kind:'configure',config:{...result.config,appId:'other-account'},accessRevision:result.access.revision})).rejects.toThrow('专用账号操作');expect(f.read().config.appId).toBe('local-account');});

it('configure RPC rejects host tools and sandbox opt-out before settings mutation',async()=>{const f=fixture();const before=f.read();for(const preset of [{name:'default',config:{provider:'omp',sandbox:null}},{name:'default',config:{provider:'omp',mcpServers:{}}},{name:'default',config:{provider:'omp'},qq:{tools:['qqbot_send_file']}},{name:'default',config:{provider:'omp'},qq:{skills:['host-skill']}}]){expect(()=>action.input.parse({kind:'configure',config:{...before.config,presets:[preset]},accessRevision:0})).toThrow();}expect(f.read()).toEqual(before);});

it('permanent gateway preparation failure does not loop and explicit restart retries it',async()=>{
  vi.useFakeTimers();
  const started=vi.spyOn(Gateway.prototype,'start').mockRejectedValueOnce(new Error('QQ 沙箱根目录不能是符号链接'));
  const disposed=vi.spyOn(Gateway.prototype,'dispose');
  const f=fixture('service');
  await vi.advanceTimersByTimeAsync(0);
  expect((await f.call(status,{})).connection).toBe('failed');
  expect(disposed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(6000);
  expect(started).toHaveBeenCalledTimes(1);
  started.mockResolvedValue();
  const result=await f.call(action,{kind:'restart'});
  expect(started).toHaveBeenCalledTimes(2);
  expect(result.reason).toBeNull();
  f.controller.abort();
  await vi.advanceTimersByTimeAsync(6000);
  expect(started).toHaveBeenCalledTimes(2);
});

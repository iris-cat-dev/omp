import type { PluginServiceContext, PluginManagementContext } from '@omp-desktop/plugin/server';
import { StateStore, Pairing, listKey, switchAccount, type State } from './state.ts';
import { status, action, sendFile, exportAccess } from './rpc.ts';
import { Binding, type Credentials } from './binding.ts';
import { Gateway } from './gateway.ts';
import { importDsh } from './importer.ts';
import type { z } from 'zod';
import type { Logger } from './types.ts';
import { formatWhitelistEntry } from './shared/pairing-protocol.ts';
const logger: Logger = {info:message=>console.info(`[qqbot] ${message}`),warn:message=>console.warn(`[qqbot] ${message}`),error:message=>console.error(`[qqbot] ${message}`),debug:message=>{if(process.env.OMP_QQBOT_DEBUG==='1'&&!/payload=|Body:|button_data|clientSecret|appSecret|access_token|authorization/i.test(message))console.debug(`[qqbot] ${message}`);}};
type Context = PluginServiceContext | PluginManagementContext;
class Runtime {
  private store: StateStore;
  private pairing: Pairing;
  private binding: Binding;
  private gateway: Gateway | null = null;
  private connection: 'waiting'|'connecting'|'ready'|'failed'='waiting';
  private reason: string | null=null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private actions: Promise<unknown>=Promise.resolve();
  private accountEpoch=0;
  private lastConfig='';
  private lastSecret: string | null=null;
  private disposed=false;
  constructor(private ctx: Context){
    this.store=new StateStore(ctx.storage);this.pairing=new Pairing(this.store);
    this.binding=new Binding(ctx.signal,credential=>{const epoch=this.accountEpoch;return this.serial(()=>this.credentials(credential,epoch));},error=>logger.warn(error instanceof Error?error.message:String(error)));
  }
  register(){
    this.ctx.handle(status,()=>this.status());
    this.ctx.handle(action,value=>this.serial(()=>this.action(value)));
    this.ctx.handle(exportAccess,value=>this.serial(async()=>{const state=(await this.store.read()).values;if(state.access.revision!==value.accessRevision)throw new Error('ACCESS_REVISION_CONFLICT');return{appId:state.config.appId,revision:state.access.revision,text:state.access[listKey(value.purpose)].map(member=>formatWhitelistEntry(member.openid,member.nickname)).join('\n')};}));
    if(this.ctx.role==='service'){
      this.ctx.handle(sendFile,async value=>{if(!this.gateway)throw new Error('QQ 网关尚未就绪');await this.gateway.sendFile(value.agentId,value.path,value.type,value.target);return{sent:true as const};});
      void this.poll();
    }
    this.ctx.signal.addEventListener('abort',()=>this.dispose(),{once:true});
  }
  private serial<T>(run:()=>Promise<T>):Promise<T>{const result=this.actions.then(()=>{if(this.disposed||this.ctx.signal.aborted)throw new Error('QQ 安装 generation 已失效');return run();});this.actions=result.catch(()=>undefined);return result;}
  private async commit(appId:string,secret:string|undefined,revision:number,update:(state:State)=>void,epoch=this.accountEpoch,expectedStorageRevision?:number){
    // Immutable secret candidates become active only with the successful scoped
    // settings CAS. Cancellation can leave an unused candidate, never replace
    // the previously active credential. The counter is not a bearer capability.
    let candidate:string|undefined;
    try{await this.store.mutate(async(s,storageRevision)=>{if(this.disposed||this.ctx.signal.aborted||epoch!==this.accountEpoch)throw new Error('绑定结果已被新账号操作替换');if(expectedStorageRevision!==undefined&&storageRevision!==expectedStorageRevision)throw new Error('STORAGE_REVISION_CONFLICT');update(s);if(secret!==undefined){const version=storageRevision+1;candidate=`app-secret:${appId}:${version}`;await this.ctx.secrets.set(candidate,secret);s.credentialVersions[appId]=version;}if(this.disposed||this.ctx.signal.aborted||epoch!==this.accountEpoch)throw new Error('绑定结果已失效');},revision);}
    catch(error){if(candidate&&!this.ctx.signal.aborted)await this.ctx.secrets.delete(candidate);throw error;}
  }
  private async credentials(credential:Credentials,epoch:number){
    const snapshot=await this.store.read();
    await this.commit(credential.appId,credential.appSecret,snapshot.values.access.revision,s=>{switchAccount(s,credential.appId);s.access.revision++;if(credential.userOpenid&&!s.access.allowC2c.some(m=>m.openid===credential.userOpenid))s.access.allowC2c.push({openid:credential.userOpenid,nickname:'扫码绑定者',scene:'c2c',sceneName:'',claimedAt:Date.now()});},epoch);
    if(this.ctx.role==='service')await this.reconcile();
  }
  private async status(){const state=(await this.store.read()).values;const version=state.credentialVersions[state.config.appId];return{generation:this.ctx.installation.generation,connection:this.connection,reason:this.ctx.role==='management'?'执行已禁用；管理账号与访问设置不会启动 QQ 网关。':this.reason,appId:state.config.appId,secretConfigured:state.config.appId&&version!==undefined?await this.ctx.secrets.configured(`app-secret:${state.config.appId}:${version}`):false,binding:this.binding.state,config:state.config,access:state.access,peers:Object.values(state.peers),challenges:[...this.pairing.challenges.values()].filter(c=>c.expiresAt>Date.now()),importReport:state.importReport};}
  private async action(value:z.output<typeof action.input>){
    switch(value.kind){
      case 'bind':case 'refresh':this.accountEpoch++;this.binding.start();break;
      case 'unbind':{const state=(await this.store.read()).values;const appId=state.config.appId;const version=state.credentialVersions[appId];await this.store.mutate(s=>{switchAccount(s,'');delete s.credentialVersions[appId];s.access.revision++;},value.accessRevision);this.accountEpoch++;this.binding.dispose();this.stopGateway();this.pairing.clear();if(appId&&version!==undefined)await this.ctx.secrets.delete(`app-secret:${appId}:${version}`);break;}
      case 'replace':{const secret=value.credentialKey?await this.ctx.secrets.get(value.credentialKey):undefined;if(value.credentialKey&&secret===null)throw new Error('凭据提交已过期，请重新输入');try{await this.commit(value.appId,secret??undefined,value.accessRevision,s=>{switchAccount(s,value.appId);s.access.revision++;});}finally{if(value.credentialKey)await this.ctx.secrets.delete(value.credentialKey);}this.accountEpoch++;this.binding.dispose();this.stopGateway();this.lastConfig='';this.pairing.clear();break;}
      case 'configure':{const previous=(await this.store.read()).values.config.sandboxPath;await this.store.mutate(s=>{if(s.config.appId!==value.config.appId)throw new Error('账号替换请使用专用账号操作');s.config=value.config;s.access.revision++;},value.accessRevision);if(previous!==value.config.sandboxPath)this.stopGateway();break;}
      case 'access':await this.store.mutate(s=>{s.access={...value.access,revision:s.access.revision+1};},value.accessRevision);break;
      case 'pair':if(this.ctx.role!=='service')throw new Error('启用 QQ 网关后才能生成可认领的配对码');if((await this.store.read()).values.access.revision!==value.accessRevision)throw new Error('ACCESS_REVISION_CONFLICT');await this.pairing.issue(value.purpose);break;
      case 'end-pair':this.pairing.challenges.delete(value.code);break;
      case 'manual':await this.pairing.manual(value.purpose,value.text,value.accessRevision);break;
      case 'revoke':await this.store.mutate(s=>{s.access[listKey(value.purpose)]=s.access[listKey(value.purpose)].filter(m=>m.openid!==value.openid);s.access.revision++;},value.accessRevision);for(const challenge of this.pairing.challenges.values())for(const claim of challenge.claims)if(claim.openid===value.openid&&challenge.purpose===value.purpose)claim.state='revoked';break;
      case 'rename':await this.store.mutate(s=>{const member=s.access[listKey(value.purpose)].find(m=>m.openid===value.openid);if(!member)throw new Error('名单成员已移除');member.nickname=value.nickname;s.access.revision++;},value.accessRevision);break;
      case 'restart':if(this.ctx.role!=='service')throw new Error('先启用插件，再重启 QQ 网关');this.stopGateway();this.lastConfig='';this.lastSecret=null;break;
      case 'import':{const before=await this.store.read();const imported=importDsh(value.document,before.values);if(imported.secret)throw new Error('AppSecret 必须通过专用 secret 操作提交，不能包含在普通导入 RPC 内');const secret=value.credentialKey?await this.ctx.secrets.get(value.credentialKey):undefined;if(value.credentialKey&&secret===null)throw new Error('导入凭据提交已过期');if(secret&&!imported.config.appId)throw new Error('导入凭据缺少 AppID');try{await this.commit(imported.config.appId,secret??undefined,value.accessRevision,s=>{switchAccount(s,imported.config.appId);s.config=imported.config;s.access={...imported.access,revision:s.access.revision+1};s.importReport=imported.report;s.presetSelections=imported.presetSelections;s.modelSelections=imported.modelSelections;},this.accountEpoch,before.revision);this.accountEpoch++;this.binding.dispose();}finally{if(value.credentialKey)await this.ctx.secrets.delete(value.credentialKey);}break;}
    }
    if(this.ctx.role==='service')await this.reconcile();return this.status();
  }
  private stopGateway(){this.gateway?.dispose();this.gateway=null;this.connection='waiting';this.reason=null;}
  private async reconcile(){
    if(this.ctx.role!=='service'||this.disposed||this.ctx.signal.aborted)return;
    const state=(await this.store.read()).values;const config=state.config;const version=state.credentialVersions[config.appId];const secret=config.appId&&version!==undefined?await this.ctx.secrets.get(`app-secret:${config.appId}:${version}`):null;
    if(this.disposed||this.ctx.signal.aborted)return;
    const encoded=JSON.stringify(config);if(encoded===this.lastConfig&&secret===this.lastSecret)return;
    this.stopGateway();this.lastConfig=encoded;this.lastSecret=secret;
    if(!config.appId||!secret){this.reason='等待 QQ AppID 与 AppSecret；可在插件设置中扫码或手动绑定。';this.ctx.waiting(this.reason);return;}
    this.ctx.waiting(null);
    const gateway=new Gateway(this.ctx,this.store,this.pairing,config,secret,logger,(state,reason)=>{if(this.gateway!==gateway||this.disposed)return;this.connection=state;this.reason=reason??null;});this.gateway=gateway;
    try{await gateway.start();}catch(error){if(this.gateway===gateway&&!this.disposed){this.connection='failed';this.reason=error instanceof Error?error.message:String(error);gateway.dispose();}}
  }
  private async poll(){try{await this.serial(()=>this.reconcile());}catch(error){if(!this.disposed){this.connection='failed';this.reason=error instanceof Error?error.message:String(error);}}if(!this.disposed&&!this.ctx.signal.aborted)this.pollTimer=setTimeout(()=>void this.poll(),2000);}
  dispose(){if(this.disposed)return;this.disposed=true;this.accountEpoch++;clearTimeout(this.pollTimer);this.binding.dispose();this.pairing.clear();this.stopGateway();this.lastSecret=null;}
}
export default function setup(ctx:PluginServiceContext){const runtime=new Runtime(ctx);runtime.register();return()=>runtime.dispose();}
export function manage(ctx:PluginManagementContext){const runtime=new Runtime(ctx);runtime.register();return()=>runtime.dispose();}

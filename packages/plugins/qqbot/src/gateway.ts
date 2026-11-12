import { QQBot, MemoryHistoryStore, errorHandler, messageFilter, mentionGate, contentSanitizer, rateLimiter, quoteRef, historyBuffer, envelopeFormatter, typingIndicator, type MiddlewareContext, type ResolvedQuote, type StreamSession } from '@tencent-connect/qqbot-nodejs';
import { RECONNECT_DELAYS, type RequestOptions } from '@tencent-connect/qqbot-nodejs/protocol';
import type { PluginServiceContext } from '@omp-desktop/plugin/server';
import type { PaseoAgent, PaseoAgentHandle, PaseoAgentStream, PaseoAgentObservation } from '@omp-desktop/client';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, basename, parse } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StateStore, Pairing, peerKey, permitted, type Peer, type Config } from './state.ts';
import { PeerQueue } from './queue.ts';
import { Cards } from './cards.ts';
import { OutboundBuffer, type QQBotSender } from './transport/outbound-buffer.ts';
import { ReplyLimiter } from './transport/reply-limiter.ts';
import { ReplyIdCache } from './transport/msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from './transport/reply-target.ts';
import { chunkMarkdownText } from './transport/chunker.ts';
import { allowedFile, downloadAttachment, cleanMedia, mediaType, validateGeneratedImage } from './media.ts';
import type { ReplyTarget, Logger } from './types.ts';
import { redactQqMessage } from './privacy.ts';
import { SandboxFiles, sandboxRelativePath } from './sandbox-files.ts';
import { z } from 'zod';
const PresentedFilesSchema=z.array(z.object({path:z.string().min(1),mimeType:z.string().optional(),name:z.string().optional()}));
const GeneratedImagesSchema=z.array(z.object({path:z.string().refine(path=>{try{return sandboxRelativePath(path)===path&&/^\.qqbot-media\/generated\/[^/]+$/.test(path);}catch{return false;}}),mimeType:z.enum(['image/png','image/jpeg','image/webp','image/gif']),name:z.string().optional()}));
interface PendingInput {target:ReplyTarget;done:()=>void;fail:(error:unknown)=>void;owned:boolean;turnId?:string}
interface Route { peer: Peer; agent: PaseoAgentHandle; unsubscribe: (() => void) | null; buffer: OutboundBuffer | null; turnId?: string; canceledTurnId?: string; target?: ReplyTarget; textRows: Map<number,string>; files:Map<string,{name:string;mimeType?:string;generatedTurnId?:string}>; toolRevisions:Map<string,string>; chain: Promise<void>; pending: Map<string,PendingInput>; localTarget?: ReplyTarget; lastSeq: number; enabledDelivery: boolean }
class SandboxConfirmationError extends Error {}
export class Gateway {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private bot: QQBot;
  private routes = new Map<string,Route>();
  private retiredAgents = new Set<string>();
  private originDelivery(scope:'c2c'|'group',item:{clientMessageId?:string;messageId?:string;sourceKind?:'user'|'service'|'agent';sourceAgentId?:string}){
    if((item.clientMessageId??item.messageId??'').startsWith(`qqbot:${this.ctx.installation.id}:`))return true;
    if(item.sourceKind==='service'||item.sourceKind==='agent'||item.sourceAgentId)return this.config.serviceTurns;
    return this.config.externalTurns==='all'||(this.config.externalTurns==='c2c'&&scope==='c2c');
  }
  private creating = new Map<string,Promise<Route>>();
  private deliveryRoute = new AsyncLocalStorage<Route>();
  private root: string | null = null;
  private openingRoot: Promise<string> | null = null;
  private files: SandboxFiles | null = null;
  private matchesConfig(config: Config) {
    return !this.signal.aborted && config.appId === this.config.appId && config.sandboxPath === this.config.sandboxPath && config.sandboxCapabilities.javascript === this.config.sandboxCapabilities.javascript && config.sandboxCapabilities.network === this.config.sandboxCapabilities.network && config.sandboxCapabilities.imageGeneration === this.config.sandboxCapabilities.imageGeneration;
  }
  private matchesSandbox(sandbox: Peer['sandbox'], root: string) {
    return sandbox?.root === root && (sandbox.javascript === true) === this.config.sandboxCapabilities.javascript && (sandbox.network === 'public') === this.config.sandboxCapabilities.network && (sandbox.imageGeneration === true) === this.config.sandboxCapabilities.imageGeneration;
  }
  private async currentConfig() {
    const config = (await this.store.read()).values.config;
    return this.matchesConfig(config);
  }
  private async activeRoute(route: Route) {
    if(!await this.currentConfig()||this.routes.get(peerKey(route.peer.appId,route.peer.scope,route.peer.openid))!==route)throw new Error('QQ 沙箱路由已替换');
  }
  private sandboxRoot(): Promise<string> {
    if (this.root) return Promise.resolve(this.root);
    return this.openingRoot ??= this.openRoot();
  }
  private requestedRoot() {
    const path = this.config.sandboxPath;
    return resolve(path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path || resolve(homedir(), '.omp', 'qqbot-sandbox', this.ctx.installation.id));
  }
  private async openRoot() {
    const requested = this.requestedRoot();
    if (requested === parse(requested).root || requested === resolve(homedir())) throw new Error('QQ 沙箱不能使用文件系统根目录或用户主目录');
    await mkdir(requested, { recursive: true, mode: 0o700 });
    if ((await lstat(requested)).isSymbolicLink()) throw new Error('QQ 沙箱根目录不能是符号链接');
    const root = await realpath(requested);
    if (root === parse(root).root || root === await realpath(homedir())) throw new Error('QQ 沙箱不能使用文件系统根目录或用户主目录');
    if (!await this.currentConfig()) throw new Error('QQ 沙箱配置已变化');
    const files=await SandboxFiles.open(this.ctx.native,root,this.config.media.maxMB*1024*1024);
    if(!await this.currentConfig()){if(!this.ctx.signal.aborted)await files.close();throw new Error('QQ 沙箱配置已变化');}
    this.files=files;
    this.root = root; this.privateValues.add(root);
    return root;
  }
  private retireRoute(route: Route) {
    const key = peerKey(route.peer.appId, route.peer.scope, route.peer.openid);
    if (this.routes.get(key) === route) this.routes.delete(key);
    route.enabledDelivery = false; route.target = undefined;
    route.unsubscribe?.(); route.buffer?.cancel(); this.cards.cancelAgent(route.peer.agentId);
    for (const pending of route.pending.values()) pending.fail(new Error('QQ 沙箱路由已替换；旧历史保留'));
  }
  private queue: PeerQueue;
  private cache = new ReplyIdCache();
  private limiter = new ReplyLimiter({limit:4});
  private sender: QQBotSender;
  private cards: Cards;
  private history = new MemoryHistoryStore();
  private streams = new Set<StreamSession>();
  private invitationReplies = new Set<string>();
  private mediaTimer: ReturnType<typeof setInterval> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectAttempts = 0;
  private finished = false;
  private privateValues = new Set<string>();
  private redact(message:string){return redactQqMessage(message,this.privateValues);}
  constructor(private ctx: PluginServiceContext, private store: StateStore, private pairing: Pairing, private config: Config, appSecret: string, private logger: Logger, private changed: (state:'connecting'|'ready'|'failed',reason?:string)=>void) {
    this.signal = AbortSignal.any([ctx.signal,this.controller.signal]);
    this.privateValues.add(appSecret);
    this.logger={debug:message=>logger.debug(this.redact(message)),info:message=>logger.info(this.redact(message)),warn:message=>logger.warn(this.redact(message)),error:message=>logger.error(this.redact(message))};
    this.bot = new QQBot({appId:config.appId,appSecret,transport:'websocket',markdownSupport:true,baseUrl:process.env.QQBOT_BASE_URL || 'https://api.bot.qq.com',tokenBaseUrl:process.env.QQBOT_TOKEN_BASE_URL || 'https://bots.qq.com',userAgent:'omp-desktop-plugin-qqbot/1.0.0',logger:this.logger});
    this.queue = new PeerQueue(config.maxQueue);
    const current = () => {
      const route = this.deliveryRoute.getStore();
      if (this.signal.aborted || (route && this.routes.get(peerKey(route.peer.appId, route.peer.scope, route.peer.openid)) !== route)) throw new Error('过期的 QQ 网关或路由 generation');
    };
    // Keep route identity through SDK timers/retries and recheck its HTTP boundary.
    const request=this.bot.apiClient.request.bind(this.bot.apiClient);
    this.bot.apiClient.request=async<T>(token:string,method:string,path:string,body?:unknown,options?:RequestOptions):Promise<T>=>{
      current();this.privateValues.add(token);const target=/^\/v2\/(users|groups)\/([^/]+)\//.exec(path);
      if(target){const scope=target[1]==='groups'?'group':'c2c';const openid=decodeURIComponent(target[2]!);const msgId=body&&typeof body==='object'&&'msg_id' in body?String(body.msg_id):'';
        if(!await this.currentConfig())throw new Error('QQ 投递账号或沙箱配置已被替换');
        if(!this.invitationReplies.has(JSON.stringify([scope,openid,msgId]))&&!await this.authorized({scope,openid},openid))throw new Error('QQ 投递目标的访问授权已撤销');}
      current();return request<T>(token,method,path,body,options);
    };
    this.sender = {sendMarkdown:async(target,text,opts)=>{current();if(!await this.authorized({scope:target.scope,openid:target.targetId},target.targetId))throw new Error('QQ 投递目标未获授权');current();return sendResolvedMarkdown(this.bot,resolveReplyTarget(target,this.limiter,true,this.cache),this.redact(text),opts);},openStream:target=>{current();const resolved=resolveReplyTarget(target,this.limiter,false,this.cache);if(!resolved.msgId)throw new Error('没有有效私聊被动回复窗口');const stream=this.bot.openStream({target:{...resolved,msgId:resolved.msgId}});this.streams.add(stream);return{update:async content=>{current();return stream.update(this.redact(content));},complete:async()=>{if(this.signal.aborted){stream.cancel();this.streams.delete(stream);current();}try{return await stream.complete();}finally{this.streams.delete(stream);}}};}};
    this.cards = new Cards(ctx.installation.generation,this.signal,this.sender,async(agentId,id,response)=>{current();await this.ctx.paseo.agents.ref(agentId).respondToPermission(id,response);},(peer,sender)=>this.cardAuthorized(peer,sender),config.askTimeoutMs,error=>this.report(error),config.requireMention);
    this.installMiddlewares();
    this.bot.on('message',async middleware=>{if(this.signal.aborted)return;this.cache.cacheMsgId(middleware.replyTarget.scope,middleware.replyTarget.targetId,middleware.replyTarget.msgId);await this.message(middleware);});
    this.bot.on('interaction',async(_context,event)=>{if(this.signal.aborted)return;const scope=event.group_openid?'group':'c2c';const openid=scope==='group'?event.group_openid:event.user_openid;if(!openid)return;this.cache.cacheEventId(scope,openid,event.id);const matched=await this.cards.interaction(scope,openid,event.group_member_openid??event.user_openid??'',event.data?.resolved?.button_data??'');if(!this.signal.aborted)await this.bot.acknowledgeInteraction(event.id,matched?0:3);});
    const connected=()=>{if(!this.signal.aborted){this.connectAttempts=0;this.changed('ready');}};
    this.bot.on('ready',connected);
    this.bot.on('resumed',connected);
    this.bot.on('error',error=>{if(!this.signal.aborted)this.report(error);});
    this.bot.on('disconnected',event=>{if(!this.signal.aborted)this.changed(event.willReconnect?'connecting':'failed',this.redact(event.reason||`QQ socket closed (${event.code})`));});
  }
  private report(error:unknown){this.logger.error(error instanceof Error?error.message:String(error));}
  private connect(){
    if(this.signal.aborted)return;
    this.changed('connecting');
    void this.bot.start(this.signal).catch(error=>{
      if(this.signal.aborted)return;
      const reason=this.redact(error instanceof Error?error.message:String(error));
      // Token prefetch runs before the SDK's WebSocket retry loop. Only retry
      // its transient failures; credentials and fatal gateway closes need action.
      if(error instanceof Error&&(error.message.startsWith('Network error getting access_token:')||/^Token fetch failed: HTTP (429|5\d\d)\b/.test(error.message))){
        this.changed('connecting',reason);
        const delay=RECONNECT_DELAYS[Math.min(this.connectAttempts++,RECONNECT_DELAYS.length-1)]!;
        this.connectTimer=setTimeout(()=>{this.connectTimer=undefined;this.connect();},delay);
      }else this.changed('failed',reason);
    });
  }
  private async retireMappedPeer(peer:Peer){
    if(this.retiredAgents.has(peer.agentId))return;
    if(!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
    const previous=await this.findAgent(peer.agentId);
    if(!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
    if(previous){await this.ctx.paseo.agents.ref(previous).stop();this.retiredAgents.add(previous.id);}
  }
  async start(){
    const state=(await this.store.read()).values;const peers=Object.values(state.peers);
    for(const peer of peers)if(peer.appId===this.config.appId){
      if(peer.hostId!==this.ctx.paseo.hostId)throw new Error('持久 QQ peer 映射属于另一 daemon；请显式迁移而不是重用 agent ID');
      if(!this.matchesSandbox(peer.sandbox,peer.cwd))await this.retireMappedPeer(peer);
    }
    try{await this.sandboxRoot();}
    catch(error){for(const peer of peers)if(peer.appId===this.config.appId)await this.retireMappedPeer(peer);throw error;}
    for(const peer of peers)if(peer.appId===this.config.appId)await this.getOrCreate(peer.scope,peer.openid);
    if(this.signal.aborted)return;
    this.connect();
    this.mediaTimer=setInterval(()=>{if(this.files)void cleanMedia(this.files,this.config.media.ttlHours).catch(error=>this.report(error));},3600000);
  }
  private async authorized(peer: Pick<Peer,'scope'|'openid'>,sender:string,command=false){const state=(await this.store.read()).values;if(!this.matchesConfig(state.config))return false;const access=state.access;const admitted=peer.scope==='c2c'?permitted(access.c2cMode,access.allowC2c,peer.openid):permitted(access.groupMode,access.allowGroup,peer.openid);return admitted&&(!command||permitted(access.commandMode,access.owners,sender));}
  private async cardAuthorized(peer:Peer,sender:string){
    if(!sender||!await this.authorized(peer,sender))return false;
    const access=(await this.store.read()).values.access;
    return access.c2cMode!=='allowlist'||access.allowC2c.some(member=>member.openid===sender);
  }
  private installMiddlewares(){
    this.bot.use(errorHandler());this.bot.use(messageFilter({skipSelfEcho:false}));
    this.bot.use(async(context,next)=>{if(context.message.kind!=='c2c'&&context.message.kind!=='group'){context.stop('unsupported-scope');return;}await next();});
    const mention=mentionGate({requireMentionInGroup:this.config.requireMention});const limit=rateLimiter();
    this.bot.use(async(context,next)=>{if(this.signal.aborted){context.stop('expired-generation');return;}const raw=context.message.content.replaceAll(`<@!${this.config.appId}>`,'').replaceAll(`<@${this.config.appId}>`,'').trim();if(!this.pairing.active(raw)){await next();return;}await mention(context,async()=>limit(context,async()=>{const claimed=await this.pairing.claim(raw,context.replyTarget.scope,context.replyTarget.targetId,context.message.senderId,context.message.senderName??'');if(!this.signal.aborted)await this.invitationReply(context,claimed);context.stop('pair-claim');}));});
    this.bot.use(async(context,next)=>{if(await this.authorized({scope:context.replyTarget.scope,openid:context.replyTarget.targetId},context.message.senderId))await next();else context.stop('access-denied');});
    this.bot.use(historyBuffer({store:this.history,limit:this.config.historyLimit,recordOnSkip:true,groupKey:context=>context.message.kind==='group'?JSON.stringify([this.config.appId,context.message.groupOpenid]):undefined}));
    this.bot.use(mention);this.bot.use(contentSanitizer({parseFaceTags:true}));this.bot.use(limit);
    this.bot.use(async(context,next)=>{const text=context.message.content.trim();if(!text.startsWith('/')){await next();return;}if(!await this.authorized({scope:context.replyTarget.scope,openid:context.replyTarget.targetId},context.message.senderId,true)){await this.sender.sendMarkdown(context.replyTarget,'该发送者没有斜杠命令权限。');context.stop('command-denied');return;}await this.command(context,text);context.stop('plugin-command');});
    this.bot.use(async(context,next)=>{const route=this.routes.get(peerKey(this.config.appId,context.replyTarget.scope,context.replyTarget.targetId));if(route&&await this.cards.text(route.peer,context.message.senderId,context.message.content)){context.stop('question-answer');return;}await next();});
    this.bot.use(typingIndicator());this.bot.use(quoteRef({maxSize:500,preferMsgElements:true}));this.bot.use(envelopeFormatter({historyLimit:this.config.historyLimit,includeQuote:true,includeSender:true}));
  }
  private getOrCreate(scope:'c2c'|'group',openid:string,reset=false):Promise<Route>{
    const key=peerKey(this.config.appId,scope,openid);const current=this.creating.get(key);
    if(current)return reset?current.then(()=>this.getOrCreate(scope,openid,true)):current;
    let work:Promise<Route>;work=this.openPeer(scope,openid,reset).finally(()=>{if(this.creating.get(key)===work)this.creating.delete(key);});this.creating.set(key,work);return work;
  }
  private async findAgent(agentId:string):Promise<PaseoAgent|null>{
    let cursor:string|undefined;
    do{
      const result=await this.ctx.paseo.agents.list({filter:{includeArchived:true},page:{limit:100,cursor}});
      for(const entry of result.entries)if(entry.agent.id===agentId)return entry.agent;
      cursor=result.pageInfo.nextCursor??undefined;
    }while(cursor!==undefined);
    return null;
  }
  private async openPeer(scope:'c2c'|'group',openid:string,reset=false):Promise<Route>{
    const key=peerKey(this.config.appId,scope,openid);
    const cwd=await this.sandboxRoot();
    if(!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
    const existing=this.routes.get(key);
    if(existing&&!reset&&this.matchesSandbox(existing.peer.sandbox,cwd))return existing;
    const state=(await this.store.read()).values;const saved=state.peers[key];
    if(saved?.hostId&&saved.hostId!==this.ctx.paseo.hostId)throw new Error('QQ peer 映射属于另一 daemon');
    const previousId=existing?.agent.id??saved?.agentId;
    const snapshot=previousId?await this.findAgent(previousId):null;
    if(previousId&&!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
    const previous=snapshot?this.ctx.paseo.agents.ref(snapshot):null;
    if(previous&&saved&&!reset&&!this.retiredAgents.has(previous.id)&&this.matchesSandbox(saved.sandbox,cwd)&&saved.cwd===cwd&&this.matchesSandbox(snapshot?.sandbox,cwd)){
      try{return await this.attach(saved,previous);}
      catch(error){if(error instanceof SandboxConfirmationError)await this.stopRejectedAgent(previous);throw error;}
    }
    if(existing)this.retireRoute(existing);
    if(previous&&!this.retiredAgents.has(previous.id))await previous.stop();
    if(!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
    const selected=state.presetSelections[key]??this.config.defaultPreset;const preset=this.config.presets.find(p=>p.name===selected);if(!preset)throw new Error(`所选 preset 不存在：${selected}`);
    if(preset.config.provider.split('/')[0]!=='omp')throw new Error('QQ 强制沙箱仅支持 OMP provider；请保留模型偏好并选择 OMP preset');
    const title=`QQ ${scope} ${openid.slice(-8)}`;
    const workspace=await this.ctx.paseo.workspaces.create({source:{kind:'directory',path:cwd},title});
    const prompt=[preset.qq.prompt,scope==='group'?this.config.groupPrompt:this.config.directPrompt,`QQ ${scope} 对话。只在当前获准目标回复。未知 QQ 斜杠命令不能操作宿主插件。`].filter(Boolean).join('\n\n');
    const model=state.modelSelections[key];
    const sandbox: NonNullable<Peer['sandbox']> = { root: cwd };
    if(this.config.sandboxCapabilities.javascript)sandbox.javascript=true;
    if(this.config.sandboxCapabilities.network)sandbox.network='public';
    if(this.config.sandboxCapabilities.imageGeneration)sandbox.imageGeneration=true;
    const config={...preset.config,provider:model?`${preset.config.provider.split('/')[0]}/${model}`:preset.config.provider,cwd,modeId:'ask',sandbox,systemPrompt:[preset.config.systemPrompt,prompt].filter(Boolean).join('\n\n')};
    if(!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
    const agent=await workspace.agents.create({config,title,labels:{'qqbot.installation':this.ctx.installation.id,'qqbot.appId':this.config.appId,'qqbot.scope':scope,'qqbot.peer':openid}});
    const peer:Peer={appId:this.config.appId,scope,openid,hostId:this.ctx.paseo.hostId,workspaceId:workspace.id,agentId:agent.id,cwd,sandbox,preset:selected,template:preset,protocolPrompt:prompt,lastDeliveredSequence:0};
    try {
      await this.store.mutate(s=>{if(!this.matchesConfig(s.config))throw new Error('QQ peer 创建结果已失效');s.peers[key]=peer;});
      if(!await this.currentConfig())throw new Error('QQ 沙箱配置已变化');
      return await this.attach(peer,agent);
    } catch(error) { await this.stopRejectedAgent(agent); throw error; }
  }
  // openPeer owns agent cleanup; a failed observation alone never stops a saved agent.
  private async stopRejectedAgent(agent:PaseoAgentHandle){
    try{await agent.stop();}catch(error){this.report(error);}
  }
  private async attach(peer:Peer,agent=this.ctx.paseo.agents.ref(peer.agentId)):Promise<Route>{
    if(!await this.currentConfig()||!this.matchesSandbox(peer.sandbox,await this.sandboxRoot()))throw new Error('QQ 沙箱路由已失效');
    const key=peerKey(peer.appId,peer.scope,peer.openid);const route:Route={peer,agent,unsubscribe:null,buffer:null,textRows:new Map(),files:new Map(),toolRevisions:new Map(),chain:Promise.resolve(),pending:new Map(),lastSeq:peer.lastDeliveredSequence,enabledDelivery:false};this.routes.set(key,route);
    const buffered:PaseoAgentStream[]=[];let observing=true;
    const receive=(stream:PaseoAgentStream)=>{if(this.signal.aborted||this.routes.get(key)!==route)return;if(stream.event.type==='turn_canceled'&&stream.event.turnId===route.turnId)route.canceledTurnId=route.turnId;if(observing){buffered.push(stream);return;}route.chain=route.chain.then(()=>this.deliveryRoute.run(route,()=>this.event(route,stream))).catch(error=>this.report(error));};
    let observation: PaseoAgentObservation;
    try { observation=await agent.observe(receive); } catch(error) { this.retireRoute(route); throw error; }
    route.unsubscribe=observation.unsubscribe;
    if(!await this.currentConfig()||this.routes.get(key)!==route||!this.matchesSandbox(observation.snapshot.sandbox,peer.cwd)){this.retireRoute(route);throw new SandboxConfirmationError('Desktop agent 未确认当前 QQ 沙箱；路由已停止，历史保留');}
    route.lastSeq=observation.timeline.window.maxSeq;
    for(const row of observation.timeline.entries)if(row.item.type==='assistant_message')route.textRows.set(row.seqEnd,row.item.text);
    let lastUser:{clientMessageId?:string;messageId?:string;sourceKind?:'user'|'service'|'agent';sourceAgentId?:string}|undefined;
    for(let index=observation.timeline.entries.length-1;index>=0;index--){const item=observation.timeline.entries[index]!.item;if(item.type==='user_message'){lastUser=item;break;}}
    if(observation.snapshot.activeTurn){route.turnId=observation.snapshot.activeTurn.turnId;route.enabledDelivery=this.originDelivery(peer.scope,lastUser??{});if(route.enabledDelivery){route.target={scope:peer.scope,targetId:peer.openid,forceProactive:true};for(const request of observation.snapshot.pendingPermissions)await this.cards.show(peer,route.target,request);}}
    if(route.enabledDelivery)for(const row of observation.timeline.entries)if(row.item.type==='tool_call')this.collectGeneratedImages(route,row.item,row.turnId);
    observing=false;for(const stream of buffered){if(observation.snapshot.activeTurn&&stream.event.type==='turn_started'&&stream.event.turnId===observation.snapshot.activeTurn.turnId)continue;receive(stream);}return route;
  }
  private async message(context:MiddlewareContext){
    const scope=context.replyTarget.scope;const openid=context.replyTarget.targetId;const key=peerKey(this.config.appId,scope,openid);
    await this.queue.enqueue(key,async()=>{
      if(this.signal.aborted)return;const route=await this.getOrCreate(scope,openid);if(!await this.authorized(route.peer,context.message.senderId))return;
      const attachments:NonNullable<Parameters<PaseoAgentHandle['send']>[1]>['attachments']=[];
      const images:Array<{data:string;mimeType:string}>=[];
      const quote=context.state.quote as ResolvedQuote|undefined;
      const incoming=[...(context.message.attachments??[]),...(quote?.attachments??[]).map(a=>({filename:a.filename,content_type:a.contentType,size:0,url:a.url,asr_refer_text:a.asrText}))];
      for(const a of incoming){
        if(!this.files)throw new Error('QQ 沙箱文件系统未就绪');
        const file=await downloadAttachment({filename:a.filename??'attachment',content_type:a.content_type,size:a.size??0,url:a.url},route.peer.cwd,this.config,this.signal,this.files);
        attachments.push({type:'uploaded_file',id:randomUUID(),fileName:basename(file.path),mimeType:file.mimeType,size:file.size,path:file.path});
        if(this.config.vision.enabled&&['image/png','image/jpeg','image/webp','image/gif'].includes(file.mimeType)){if(file.size>this.config.vision.maxBytes)throw new Error('图片超过原生视觉输入上限');images.push({data:(await this.files.read(file.relativePath,this.config.vision.maxBytes)).toString('base64'),mimeType:file.mimeType});}
      }
      if(!await this.currentConfig()||this.routes.get(key)!==route)throw new Error('QQ 沙箱路由已替换');
      if(!await this.authorized(route.peer,context.message.senderId))throw new Error('QQ 发送者访问授权已撤销');
      const id=`qqbot:${this.ctx.installation.id}:${randomUUID()}`;const text=String(context.state.envelope??context.message.content)+((context.message.attachments??[]).map(a=>a.asr_refer_text?`\n语音转录：${a.asr_refer_text}`:'').join(''));
      let done!:()=>void;let fail!:(error:unknown)=>void;const completion=new Promise<void>((resolve,reject)=>{done=resolve;fail=reject;});const pending:PendingInput={target:{scope,targetId:openid,msgId:context.replyTarget.msgId},done,fail,owned:false};route.pending.set(id,pending);route.localTarget=context.replyTarget;
      const timer=setTimeout(()=>{if(this.signal.aborted)return;if(pending.owned&&(!pending.turnId||pending.turnId===route.turnId))void route.agent.stop().catch(error=>this.report(error));fail(new Error('QQ 回合处理超时，当前 QQ 路由已取消'));},this.config.processingTimeoutMs);
      const abort=()=>fail(new Error('QQ 路由取消，Desktop agent 保留运行状态'));this.signal.addEventListener('abort',abort,{once:true});
      try{await Promise.all([route.agent.send(this.redact(text)||'请回复本次 QQ @ 提及',{messageId:id,attachments,images}).then(()=>{if(scope==='group')this.history.clear(JSON.stringify([this.config.appId,openid]));}),completion]);}
      finally{clearTimeout(timer);this.signal.removeEventListener('abort',abort);route.pending.delete(id);route.localTarget=undefined;}
    });
  }
  private collectGeneratedImages(route:Route,item:{name:string;status:string;metadata?:Record<string,unknown>},turnId?:string){
    if(!this.config.sandboxCapabilities.imageGeneration||route.peer.sandbox?.imageGeneration!==true||!turnId||turnId!==route.turnId||item.name!=='generate_image'||item.status!=='completed'||item.metadata?.generatedImagesSource!=='omp-sandbox-image')return;
    const parsed=GeneratedImagesSchema.safeParse(item.metadata.generatedImages);
    if(!parsed.success)return;
    for(const file of parsed.data)route.files.set(file.path,{name:file.name??basename(file.path),mimeType:file.mimeType,generatedTurnId:turnId});
  }
  private async event(route:Route,stream:PaseoAgentStream){
    if(!await this.currentConfig()||this.routes.get(peerKey(route.peer.appId,route.peer.scope,route.peer.openid))!==route)return;const event=stream.event;
    if(event.type!=='turn_started'&&'turnId' in event&&event.turnId&&route.turnId&&event.turnId!==route.turnId)return;
    if(event.type==='timeline'&&event.item.type==='user_message'&&stream.seq!==undefined&&stream.seq<=route.lastSeq)return;
    if(event.type==='turn_started'){route.turnId=event.turnId;route.enabledDelivery=!!route.localTarget;route.target=route.localTarget;route.buffer?.cancel();route.buffer=null;route.textRows.clear();route.files.clear();route.toolRevisions.clear();}
    if(event.type==='timeline'&&event.item.type==='user_message'){
      const item=event.item as typeof event.item&{clientMessageId?:string;sourceKind?:'user'|'service'|'agent'};const pending=route.pending.get(item.clientMessageId??item.messageId??'');
      if(pending){pending.owned=true;pending.turnId=event.turnId??route.turnId;}
      route.enabledDelivery=!!pending||this.originDelivery(route.peer.scope,item);
      route.target=pending?.target??{scope:route.peer.scope,targetId:route.peer.openid,forceProactive:true};
    }
    if(event.type==='timeline'&&event.item.type==='assistant_message'&&route.enabledDelivery&&route.target){
      const seq=stream.seq??-1;const previous=route.textRows.get(seq)??'';const text=event.item.text;route.textRows.set(seq,text);
      if(text===previous)return;if(!route.buffer)route.buffer=new OutboundBuffer(route.target,this.sender,this.config.textChunkLimit,this.logger,this.config.streaming&&route.peer.scope==='c2c'&&!route.target.forceProactive);
      if(text.startsWith(previous))route.buffer.append(text.slice(previous.length));else{route.buffer.reset();route.buffer.append(text);}
    }
    if(event.type==='timeline'&&event.item.type==='tool_call'&&route.enabledDelivery&&route.target){
      const item=event.item;const revision=`${stream.contentVersion??0}:${item.revision??0}:${item.status}`;
      if(route.toolRevisions.get(item.callId)!==revision){route.toolRevisions.set(item.callId,revision);
        if(item.status==='completed'&&this.config.showToolResults)await this.sender.sendMarkdown(route.target,`工具完成：${item.name}`);
        if(item.status==='completed'&&item.metadata?.presentedFilesSource==='omp-present-image'&&this.config.sendFile.sendPresentedFiles){for(const file of PresentedFilesSchema.parse(item.metadata.presentedFiles))route.files.set(file.path,{name:file.name??basename(file.path),mimeType:file.mimeType});}
        this.collectGeneratedImages(route,item,event.turnId);
      }
    }
    if(event.type==='permission_requested'&&route.enabledDelivery&&route.target&&this.routes.get(peerKey(route.peer.appId,route.peer.scope,route.peer.openid))===route)await this.cards.show(route.peer,route.target,event.request);
    if(event.type==='permission_resolved')this.cards.resolved(route.peer.agentId,event.requestId);
    if(event.type==='turn_completed'||event.type==='turn_failed'||event.type==='turn_canceled'){
      if(event.type==='turn_canceled')route.canceledTurnId=route.turnId;
      if(event.type!=='turn_completed')for(const [path,file] of route.files)if(file.generatedTurnId)route.files.delete(path);
      try {
      if(route.buffer){if(event.type==='turn_completed')await route.buffer.flush();else route.buffer.cancel();route.buffer=null;}
      if(event.type==='turn_failed'&&route.enabledDelivery&&route.target)await this.sender.sendMarkdown(route.target,'对话失败，请在 Desktop 查看详情。');
      if(route.enabledDelivery&&route.target&&route.files.size){let index=0;const missed:string[]=[];for(const [path,file] of route.files){if(index++>=this.config.sendFile.maxFiles){missed.push('文件超出单轮上限');continue;}try{await this.deliverFile(route,path,file.mimeType?.startsWith('image/')?'image':mediaType(path),route.target);}catch{missed.push('文件未通过沙箱投递检查');}}if(missed.length)for(const chunk of chunkMarkdownText(`文件未投递：\n${missed.join('\n')}`,this.config.textChunkLimit))await this.sender.sendMarkdown(route.target,chunk);route.files.clear();}
      } finally {
      for(const pending of route.pending.values()){if(!pending.owned||(pending.turnId&&event.turnId&&pending.turnId!==event.turnId))continue;if(event.type==='turn_failed')pending.fail(new Error(event.error));else pending.done();}
      route.enabledDelivery=false;route.target=undefined;
      if(stream.seq!==undefined)route.lastSeq=Math.max(route.lastSeq,stream.seq);
      await this.store.mutate(s=>{const p=s.peers[peerKey(route.peer.appId,route.peer.scope,route.peer.openid)];if(p?.agentId===route.peer.agentId)p.lastDeliveredSequence=route.lastSeq;});
      }
    }
    if(stream.seq!==undefined)route.lastSeq=Math.max(route.lastSeq,stream.seq);
  }
  private async command(context:MiddlewareContext,text:string){
    const match=/^\/([^\s]+)\s*(.*)$/s.exec(text)!;const command=match[1]!.toLowerCase();const arg=match[2]!.trim();const scope=context.replyTarget.scope;const openid=context.replyTarget.targetId;const key=peerKey(this.config.appId,scope,openid);let reply:string;
    if(command==='bot-help'||command==='help')reply='/new /reset /stop /compact /model [id] /preset [name|reset] /status /whoami /bot-help';
    else if(command==='preset'){const state=(await this.store.read()).values;if(!arg)reply=`下一次新对话：${state.presetSelections[key]??this.config.defaultPreset}\n${this.config.presets.map(p=>p.name).join('\n')}`;else{if(arg!=='reset'&&arg!=='default'&&!this.config.presets.some(p=>p.name===arg))throw new Error(`未知 preset：${arg}`);await this.store.mutate(s=>{if(this.signal.aborted||s.config.appId!==this.config.appId||s.config.sandboxPath!==this.config.sandboxPath)throw new Error('QQ 配置已变化');if(arg==='reset'||arg==='default')delete s.presetSelections[key];else s.presetSelections[key]=arg;});reply='Preset 已保存，仅下一次 /new 或 /reset 生效。';}}
    else if(command==='new'||command==='reset'){await this.queue.enqueue(key,async()=>{await this.getOrCreate(scope,openid,true);});reply='已创建新的 Desktop agent，旧对话历史保持可恢复。';}
    else if(command==='whoami')reply=`scope=${scope}\npeer=${openid}\nsender=${context.message.senderId}`;
    else if(command==='stop'){const route=this.routes.get(key);if(route){route.canceledTurnId=route.turnId;await route.agent.stop();}reply=route?'已请求停止当前 agent。':'当前没有对话。';}
    else if(command==='compact'){const route=await this.getOrCreate(scope,openid);await this.activeRoute(route);await route.agent.compact();reply='已请求原生对话压缩。';}
    else if(command==='model'){const route=await this.getOrCreate(scope,openid);if(!arg){const snapshot=await route.agent.refresh();if(!snapshot)throw new Error('Desktop agent 不存在');await this.activeRoute(route);const models=await this.ctx.paseo.providers.listModels(snapshot.agent.provider,{cwd:route.peer.cwd});reply=JSON.stringify(models,null,2);}else{const model=arg==='default'?null:arg;await this.activeRoute(route);await route.agent.setModel(model);await this.store.mutate(s=>{if(!this.matchesConfig(s.config)||s.peers[key]?.agentId!==route.peer.agentId)throw new Error('QQ 模型选择结果已失效');s.modelSelections[key]=model;});reply='模型已由 Desktop 更新并保存到此 QQ peer 偏好。';}}
    else if(command==='status'){const route=this.routes.get(key);const current=route?await route.agent.refresh():null;reply=current?`${current.agent.status}\nagent=${current.agent.id}\nworkspace=${route!.peer.workspaceId}\nmodel=${current.agent.model??'默认'}`:'当前没有对话。';}
    else reply='未知 QQ 插件命令。发送 /bot-help；不会转发给宿主插件管理器。';
    for(const chunk of chunkMarkdownText(reply,this.config.textChunkLimit))await this.sender.sendMarkdown(context.replyTarget,chunk);
  }
  async sendFile(_agentId:string,_path:string,_type:'image'|'video'|'voice'|'file',_target?:{scope:'c2c'|'group';openid:string}){
    throw new Error('QQ 沙箱不允许宿主 qqbot_send_file 工具；仅可显式开启沙箱文件自动投递');
  }
  private async deliverFile(route:Route,path:string,type:'image'|'video'|'voice'|'file',target:ReplyTarget){
    if(this.signal.aborted||this.routes.get(peerKey(this.config.appId,route.peer.scope,route.peer.openid))!==route)throw new Error('QQ 网关 generation 已过期');
    if(!await this.authorized({scope:target.scope,openid:target.targetId},target.targetId))throw new Error('当前投递目标没有 QQ 访问授权');
    const file=route.files.get(path);const generated=file?.generatedTurnId;
    if(generated){
      if(!this.config.sandboxCapabilities.imageGeneration||route.peer.sandbox?.imageGeneration!==true||!route.enabledDelivery||generated!==route.turnId||generated===route.canceledTurnId||route.target?.scope!==target.scope||route.target?.targetId!==target.targetId||target.scope!==route.peer.scope||target.targetId!==route.peer.openid)throw new Error('生成图片投递授权或回合已失效');
    }else if(!this.config.sendFile.sendPresentedFiles)throw new Error('QQ 沙箱文件投递未开启');
    if(!this.files)throw new Error('QQ 沙箱文件系统未就绪');
    const buffer=await allowedFile(path,route.peer,this.config,this.files);const reply=resolveReplyTarget(target,this.limiter,false,this.cache);
    if(generated)validateGeneratedImage(buffer,file!.mimeType!);
    if(!await this.currentConfig()||this.routes.get(peerKey(this.config.appId,route.peer.scope,route.peer.openid))!==route)throw new Error('QQ 网关 generation 已过期');
    if(!await this.authorized({scope:target.scope,openid:target.targetId},target.targetId))throw new Error('当前投递目标没有 QQ 访问授权');
    if(generated&&(!route.enabledDelivery||route.turnId!==generated||generated===route.canceledTurnId||route.target?.scope!==target.scope||route.target?.targetId!==target.targetId))throw new Error('生成图片回合已失效');
    if(type==='image')await this.bot.sendImage(reply,{buffer});else if(type==='video')await this.bot.sendVideo(reply,{buffer});else if(type==='voice')await this.bot.sendVoice(reply,{buffer});else await this.bot.sendFile(reply,{buffer},{fileName:basename(path)});
  }
  private async invitationReply(context:MiddlewareContext,claimed:boolean){
    const key=JSON.stringify([context.replyTarget.scope,context.replyTarget.targetId,context.replyTarget.msgId??'']);this.invitationReplies.add(key);
    try{await this.bot.sendMarkdown(context.replyTarget,claimed?'已认领该访问名单身份。':'配对码已过期或已撤销；本次没有修改访问名单。');}finally{this.invitationReplies.delete(key);}
  }
  dispose(){if(this.finished)return;this.finished=true;this.controller.abort();this.queue.dispose();this.cards.dispose();clearInterval(this.mediaTimer);clearTimeout(this.connectTimer);for(const stream of this.streams)stream.cancel();this.streams.clear();this.invitationReplies.clear();for(const route of this.routes.values()){route.unsubscribe?.();route.buffer?.cancel();for(const pending of route.pending.values())pending.fail(new Error('QQ 路由已取消；原生 agent 保留'));}this.routes.clear();this.cache.clear();this.bot.stop();if(this.files){if(!this.ctx.signal.aborted)void this.files.close().catch(error=>this.report(error));this.files=null;}}
}

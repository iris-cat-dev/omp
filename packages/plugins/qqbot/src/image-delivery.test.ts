import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink, link, utimes, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import type { PluginServiceContext, PluginStorage, PluginNativeApi } from '@omp-desktop/plugin/server';
import type { PaseoAgentHandle, PaseoAgentStream, PaseoAgentObservation } from '@omp-desktop/client';
import { Gateway } from './gateway.ts';
import { Pairing, StateSchema, StateStore, PeerSchema, peerKey, type Peer } from './state.ts';
import { SandboxFiles } from './sandbox-files.ts';
import type { ReplyTarget } from './types.ts';
import { cleanMedia } from './media.ts';

const sdkRoot=process.env.OMP_DESKTOP_TEST_SDK_ROOT;
if(!sdkRoot||!isAbsolute(sdkRoot)||!existsSync(join(sdkRoot,'package.json'))||!existsSync(join(sdkRoot,'dist','node','modules.json'))){
  throw new Error('QQ image delivery tests require a real built Desktop Node SDK: set OMP_DESKTOP_TEST_SDK_ROOT to its @oh-my-pi/pi-coding-agent package root (npm run build:omp-sdk:dev).');
}
// Resolve from the explicitly staged SDK, never the workspace's generic native addon.
const {SandboxFs:NativeSandboxFs}=createRequire(join(sdkRoot,'package.json'))('@oh-my-pi/pi-natives') as {SandboxFs:new(root:string,maxBytes:number)=>NativeFiles};
if(typeof NativeSandboxFs!=='function')throw new Error('OMP_DESKTOP_TEST_SDK_ROOT must contain a Desktop native addon exporting the real SandboxFs primitive; rebuild the staged Desktop SDK.');

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const imagePath='.qqbot-media/generated/real.png';
const cleanups:Array<()=>Promise<void>|void>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.restoreAllMocks();});
interface NativeFiles { read(path:string,maxBytes?:number):Buffer;list(path:string):Array<{name:string;isDirectory:boolean;size:number;modifiedAt:number}>;mkdir(path:string):void;remove(path:string):void;close():void }
interface TestRoute {
  peer:Peer;agent:PaseoAgentHandle;unsubscribe:null;buffer:null;
  turnId?:string;target?:ReplyTarget;localTarget?:ReplyTarget;enabledDelivery:boolean;
  textRows:Map<number,string>;files:Map<string,{name:string;mimeType?:string;generatedTurnId?:string}>;
  toolRevisions:Map<string,string>;pending:Map<string,never>;chain:Promise<void>;lastSeq:number;
}
async function fixture(enabled=true,scope:'c2c'|'group'='c2c') {
  const directory=await mkdtemp(join(tmpdir(),'qq-generated-image-'));
  cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const root=await realpath(directory);
  await mkdir(join(root,'.qqbot-media/generated'),{recursive:true});
  await writeFile(join(root,imagePath),png);
  // Exercise the staged Desktop addon's real descriptor-bound primitive.
  const pinned=new NativeSandboxFs(root,1024*1024);
  let afterRead:(()=>Promise<void>)|undefined;
  const native={invoke:async(_operation:string,input:unknown)=>{
    const request=input as {action:string;path:string;maxBytes:number};
    if(request.action==='open')return{handle:'real-native-pinned'};
    if(request.action==='close'){pinned.close();return{ok:true};}
    if(request.action==='read'){const bytes=pinned.read(request.path,request.maxBytes);await afterRead?.();return{contentBase64:bytes.toString('base64')};}
    if(request.action==='mkdir'){pinned.mkdir(request.path);return{ok:true};}
    if(request.action==='list')return{entries:pinned.list(request.path)};
    if(request.action==='remove'){pinned.remove(request.path);return{ok:true};}
    throw new Error(`Unexpected sandbox operation: ${request.action}`);
  }} as PluginNativeApi;
  const files=await SandboxFiles.open(native,root,1024*1024);
  cleanups.push(()=>files.close());
  let values=StateSchema.parse({config:{appId:'app',sandboxPath:root,sandboxCapabilities:{imageGeneration:enabled},media:{maxMB:1}}});
  const store=new StateStore({get:async()=>({revision:0,values:structuredClone(values)}),patch:async(patch:unknown)=>{values=StateSchema.parse(patch);return{revision:0,values};}} as PluginStorage);
  const peer=PeerSchema.parse({appId:'app',scope,openid:'peer',hostId:'host',workspaceId:'workspace',agentId:'agent',cwd:root,sandbox:{root,...(enabled?{imageGeneration:true}:{})},preset:'default',template:values.config.presets[0],protocolPrompt:'QQ',lastDeliveredSequence:0});
  const target:ReplyTarget={scope,targetId:'peer',forceProactive:true};
  const ctx={signal:new AbortController().signal,installation:{id:'installation',generation:7},paseo:{},native} as unknown as PluginServiceContext;
  const gateway=new Gateway(ctx,store,new Pairing(store),values.config,'fixture-secret',{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},vi.fn());
  cleanups.push(()=>gateway.dispose());
  const internal=gateway as unknown as {files:SandboxFiles;root:string;routes:Map<string,TestRoute>;event(route:TestRoute,stream:PaseoAgentStream):Promise<void>;attach(peer:TestRoute['peer'],agent:PaseoAgentHandle):Promise<TestRoute>;command(context:unknown,text:string):Promise<void>;deliverFile(route:TestRoute,path:string,type:'image',target:ReplyTarget):Promise<void>;bot:QQBot;sender:{sendMarkdown(target:ReplyTarget,text:string):Promise<unknown>}};
  internal.files=files;internal.root=root;
  const route:TestRoute={peer,agent:{id:'agent'} as PaseoAgentHandle,unsubscribe:null,buffer:null,enabledDelivery:false,localTarget:target,textRows:new Map(),files:new Map(),toolRevisions:new Map(),pending:new Map(),chain:Promise.resolve(),lastSeq:0};
  internal.routes.set(peerKey('app',scope,'peer'),route);
  const send=vi.spyOn(internal.bot,'sendImage').mockResolvedValue({upload:{file_uuid:'uploaded',file_info:'qq-media',ttl:60},message:undefined});
  const markdown=vi.spyOn(internal.sender,'sendMarkdown').mockResolvedValue(undefined);
  const event=(event:unknown,seq=1,contentVersion=1)=>internal.event(route,{seq,contentVersion,event} as PaseoAgentStream);
  const start=()=>event({type:'turn_started',turnId:'turn-current'},0);
  const complete=()=>event({type:'turn_completed',turnId:'turn-current'},3);
  return{root,files,store,gateway,internal,route,target,send,markdown,event,start,complete,setAfterRead:(hook:()=>Promise<void>)=>{afterRead=hook;}};
}
function item(overrides:Record<string,unknown>={}) {return{type:'tool_call',callId:'generate',name:'generate_image',status:'completed',revision:1,metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path:imagePath,mimeType:'image/png',name:'Generated image'}]},...overrides};}

it.each(['c2c','group'] as const)('sends real generated PNG buffers to the current %s target without the presented-file flag',async scope=>{
  const f=await fixture(true,scope);await f.start();
  await f.event({type:'timeline',turnId:'turn-current',item:item()});
  await f.event({type:'timeline',turnId:'turn-current',item:item()},1,2);
  expect(f.route.files.size).toBe(1);
  await f.complete();await f.complete();
  await f.event({type:'timeline',turnId:'turn-current',item:item()},1,3);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({scope,targetId:'peer'}),{buffer:png});
  expect(f.markdown).not.toHaveBeenCalled();
});

it.each(['disabled','failed','empty','wrong-name','wrong-source','old-turn','missing-turn'] as const)('never sends generated images for %s results',async kind=>{
  const f=await fixture(kind!=='disabled');await f.start();
  const tool=kind==='failed'?item({status:'failed'}):kind==='empty'?item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[]}}):kind==='wrong-name'?item({name:'read'}):kind==='wrong-source'?item({metadata:{generatedImagesSource:'other',generatedImages:[{path:imagePath,mimeType:'image/png'}]}}):item();
  await f.event({type:'timeline',...(kind==='missing-turn'?{}:{turnId:kind==='old-turn'?'turn-old':'turn-current'}),item:tool});
  await f.complete();expect(f.send).not.toHaveBeenCalled();expect(f.markdown).not.toHaveBeenCalled();
});

it.each(['grant','access','generation','turn'] as const)('revoking %s while reading blocks the actual QQ image boundary',async change=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  f.setAfterRead(async()=>{
    if(change==='grant')await f.store.mutate(state=>{state.config.sandboxCapabilities.imageGeneration=false;});
    if(change==='access')await f.store.mutate(state=>{state.access.c2cMode='disabled';});
    if(change==='generation')f.internal.routes.delete(peerKey('app','c2c','peer'));
    if(change==='turn')f.route.turnId='turn-next';
  });
  await expect(f.internal.deliverFile(f.route,imagePath,'image',f.target)).rejects.toThrow();
  expect(f.send).not.toHaveBeenCalled();
});

it.each(['outside','symlink','hardlink','mime'] as const)('rejects %s artifacts before sending an image',async kind=>{
  const f=await fixture();await f.start();
  let path=imagePath;let mimeType='image/png';
  if(kind==='outside')path=join(f.root,imagePath);
  if(kind==='symlink'){path='.qqbot-media/generated/link.png';await symlink(join(f.root,imagePath),join(f.root,path));}
  if(kind==='hardlink'){path='.qqbot-media/generated/hard.png';await link(join(f.root,imagePath),join(f.root,path));}
  if(kind==='mime')mimeType='image/jpeg';
  await f.event({type:'timeline',turnId:'turn-current',item:item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path,mimeType}]}})});
  await f.complete();expect(f.send).not.toHaveBeenCalled();
});

it('binds generated images to the route target and preserves send failure reporting',async()=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  await expect(f.internal.deliverFile(f.route,imagePath,'image',{scope:'c2c',targetId:'another-peer'})).rejects.toThrow('授权或回合');
  f.send.mockRejectedValue(new Error('QQ upload failed'));
  await f.complete();expect(f.send).toHaveBeenCalledOnce();
  expect(f.markdown).toHaveBeenCalledWith(f.target,expect.stringContaining('文件未投递'));
});

it('restores only active-turn generated metadata on observation replay and sends it once',async()=>{
  const f=await fixture();
  const agent={id:'agent',observe:async()=>({snapshot:{sandbox:f.route.peer.sandbox,pendingPermissions:[],activeTurn:{turnId:'turn-current'}},timeline:{window:{maxSeq:2},entries:[{seqEnd:1,turnId:'turn-old',item:item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path:'.qqbot-media/generated/old.png',mimeType:'image/png'}]}})},{seqEnd:2,turnId:'turn-current',item:item()}]},unsubscribe:()=>{}} as unknown as PaseoAgentObservation)} as PaseoAgentHandle;
  const route=await f.internal.attach(f.route.peer,agent);
  expect([...route.files.keys()]).toEqual([imagePath]);
  await f.internal.event(route,{seq:3,event:{type:'turn_completed',turnId:'turn-current'}} as PaseoAgentStream);
  await f.internal.event(route,{seq:3,event:{type:'turn_completed',turnId:'turn-current'}} as PaseoAgentStream);
  expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({scope:'c2c',targetId:'peer'}),{buffer:png});
});

it('sends each real generated artifact once and ignores a late result from a previous turn',async()=>{
  const f=await fixture();await f.start();
  const second='.qqbot-media/generated/second.png';await writeFile(join(f.root,second),png);
  await f.event({type:'timeline',turnId:'turn-current',item:item({metadata:{generatedImagesSource:'omp-sandbox-image',generatedImages:[{path:imagePath,mimeType:'image/png'},{path:second,mimeType:'image/png'}]}})});
  await f.complete();expect(f.send).toHaveBeenCalledTimes(2);
  await f.event({type:'turn_started',turnId:'turn-next'},4);
  await f.event({type:'timeline',turnId:'turn-current',item:item()},5,3);
  await f.event({type:'turn_completed',turnId:'turn-current'},6);
  expect(f.route.turnId).toBe('turn-next');expect(f.route.files.size).toBe(0);
  await f.event({type:'turn_completed',turnId:'turn-next'},7);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it.each(['turn_canceled','turn_failed'] as const)('discards queued generated images on %s without sending a completion image',async type=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  expect(f.route.files.size).toBe(1);
  await f.event({type,turnId:'turn-current',error:'turn failed'},3);
  expect(f.send).not.toHaveBeenCalled();expect(f.route.files.size).toBe(0);
  if(type==='turn_canceled')expect(f.markdown).not.toHaveBeenCalled();
});

it('blocks image upload when /stop arrives during the pinned read',async()=>{
  const f=await fixture();await f.start();await f.event({type:'timeline',turnId:'turn-current',item:item()});
  f.route.agent={id:'agent',stop:vi.fn(async()=>{})} as unknown as PaseoAgentHandle;
  f.setAfterRead(()=>f.internal.command({replyTarget:f.target,message:{senderId:'peer'}},'/stop'));
  await expect(f.internal.deliverFile(f.route,imagePath,'image',f.target)).rejects.toThrow('回合已失效');
  expect(f.send).not.toHaveBeenCalled();
});

it('blocks a queued upload immediately when observation receives cancellation during the pinned read',async()=>{
  const f=await fixture();let receive!:(stream:PaseoAgentStream)=>void;
  const agent={id:'agent',observe:async(callback:typeof receive)=>{receive=callback;return{snapshot:{sandbox:f.route.peer.sandbox,pendingPermissions:[],activeTurn:{turnId:'turn-current'}},timeline:{window:{maxSeq:1},entries:[{seqEnd:1,turnId:'turn-current',item:item()}]},unsubscribe:()=>{}} as unknown as PaseoAgentObservation;}} as unknown as PaseoAgentHandle;
  const route=await f.internal.attach(f.route.peer,agent);
  f.setAfterRead(async()=>{receive({seq:3,event:{type:'turn_canceled',turnId:'turn-current'}} as PaseoAgentStream);});
  receive({seq:2,event:{type:'turn_completed',turnId:'turn-current'}} as PaseoAgentStream);
  await route.chain;
  expect(f.send).not.toHaveBeenCalled();
});

it('applies media TTL only to exclusive generated UUID image filenames and leaves other sandbox files intact',async()=>{
  const f=await fixture();
  const expired='.qqbot-media/generated/11111111-1111-4111-8111-111111111111.png';
  const fresh='.qqbot-media/generated/22222222-2222-4222-8222-222222222222.webp';
  const unrelated='.qqbot-media/generated/33333333-3333-4333-8333-333333333333.txt';
  const nested='.qqbot-media/generated/44444444-4444-4444-8444-444444444444.png';
  await writeFile(join(f.root,expired),png);await writeFile(join(f.root,fresh),png);await writeFile(join(f.root,unrelated),'keep');await mkdir(join(f.root,nested));
  const old=new Date(Date.now()-48*3600000);
  await utimes(join(f.root,expired),old,old);await utimes(join(f.root,imagePath),old,old);await utimes(join(f.root,unrelated),old,old);
  await cleanMedia(f.files,0);expect(await f.files.read(expired)).toEqual(png);
  await cleanMedia(f.files,24);
  await expect(stat(join(f.root,expired))).rejects.toMatchObject({code:'ENOENT'});
  expect(await f.files.read(fresh)).toEqual(png);expect(await f.files.read(imagePath)).toEqual(png);
  expect((await f.files.read(unrelated)).toString()).toBe('keep');expect((await stat(join(f.root,nested))).isDirectory()).toBe(true);
});

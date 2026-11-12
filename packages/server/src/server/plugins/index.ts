import path from "node:path";
import type pino from "pino";
import { PluginIdSchema, type PluginLogEntry, type PluginListItem, type PluginSource } from "@omp-desktop/protocol/messages";
import type { DesktopPluginCatalogEntry, DesktopPluginApprovalSchema, DesktopPluginExpectedInstallation } from "@omp-desktop/protocol/desktop-plugins";
import type { z } from "zod";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginRuntime, type PluginOmpSessionHost } from "./runtime.js";
import { inspectPluginPackage, compilePlugin, compilePackageEntries, type InspectedPluginPackage, type CompiledPluginBundles } from "@omp-desktop/plugin/compiler";
import { PluginDataStore } from "./storage.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { PluginAgentPromptSelection } from "@omp-desktop/plugin/server";
import { SandboxFileLeases } from "./sandbox-file-leases.js";

type Approval=z.infer<typeof DesktopPluginApprovalSchema>;
export interface PluginRuntimePort {
 catalog():Array<{id:string;clientBundle:string}>;
 invoke(id:string,method:string,input:unknown,generation?:number):Promise<unknown>;
 getLogs(id:string):PluginLogEntry[]; clearLogs(id:string):void;
 startPlugin(id:string,directory:string,canPublish:()=>boolean,info?:InspectedPluginPackage,grants?:readonly string[],mode?:"manage"|"active",bundles?:CompiledPluginBundles):Promise<void>;
 stopPluginById(id:string):Promise<boolean>;stopAll():Promise<void>;
 subscribe(listener:(id:string,error?:string)=>void):()=>void;
 bindOmpSessionHost(host:PluginOmpSessionHost):void;
 bindHostCall?(handler:(id:string,operation:string,input:unknown)=>unknown|Promise<unknown>):void;
 generation?(id:string):number; waitingReason?(id:string):string|undefined;
 invalidateGeneration?(id:string):void;
}
export class PluginService {
 private readonly runtime:PluginRuntimePort;
 private readonly errors=new Map<string,string>();
 private readonly descriptions=new Map<string,InspectedPluginPackage>();
 private readonly bundles=new Map<string,CompiledPluginBundles>();
 private readonly listeners=new Set<(id:string)=>void>();
 private readonly operations=new Map<string,Promise<unknown>>();
 private readonly epochs=new Map<string,number>();
 private readonly starting=new Set<string>();
 private readonly managementWorkers=new Set<string>();
 private readonly inheritedTrust=new Set<string>();
 private readonly agentTools=new Map<string,Map<string,{name:string;description:string;inputJsonSchema:Record<string,unknown>}>>();
 private readonly agentPrompts=new Map<string,Set<string>>();
 private globalStartsBlocked=true;
 private started=false;
 private closing=false;
 private revision=0;
 private unsubscribeConfig:(()=>void)|undefined;
 private readonly data:PluginDataStore;
 private readonly sandboxFiles:SandboxFileLeases;
 constructor(private readonly logger:pino.Logger,private readonly configStore:DaemonConfigStore,runtime:PluginRuntimePort=new PluginRuntime(logger),home?:string) {
  this.runtime=runtime;
  for(const [id,source] of Object.entries(configStore.get().plugins??{}))if(source.bundled!==true&&source.enabled!==false&&!source.approval)this.inheritedTrust.add(id);
  this.data=new PluginDataStore(home??configStore.storageDirectory());
  this.sandboxFiles=new SandboxFileLeases(()=>configStore.get().providers.omp);
  runtime.bindHostCall?.((id,operation,input)=>this.hostOperation(id,operation,input));
  runtime.subscribe((id,error)=>{if(error){this.revoke(id);this.errors.set(id,error);}this.notify(id);});
 }
 bindOmpSessionHost(host:PluginOmpSessionHost){this.runtime.bindOmpSessionHost(host);}
 subscribe(listener:(id:string)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 getRevision(){return this.revision;}
 getGeneration(id:string){return this.runtime.generation?.(id)??this.epochs.get(id)??0;}
 pluginsEnabled(){return this.configStore.get().pluginsEnabled===true;}
 async start(){
  if(this.started)return;this.started=true;this.globalStartsBlocked=!this.pluginsEnabled();
  this.unsubscribeConfig=this.configStore.onFieldChange("pluginsEnabled",value=>this.handleGlobalSwitch(value===true));
  for(const id of Object.keys(this.configStore.get().plugins??{})){
   if(this.configStore.get().plugins?.[id]?.bundled===true)continue;
   void this.enqueue(id,async()=>{await this.discover(id);if(this.canRun(id))await this.activate(id);this.notify(id);}).catch(error=>this.fail(id,error));
  }
 }
 private approved(id:string,info:InspectedPluginPackage){
  const source=this.source(id);
  if(source.trustRevoked===true)return false;
  if(!source.approval)return info.format==="legacy" && this.inheritedTrust.has(id);
  return source.approval.version===info.version && info.capabilities.every(cap=>source.approval!.capabilities.includes(cap));
 }
 private grants(id:string){const source=this.source(id);return source.trustRevoked===true?[]:source.approval?.capabilities??[];}
 private async discover(id:string){
  try{
   const info=await inspectPluginPackage(path.resolve(this.source(id).path));
   if(info.metadata?.owner==="desktop")throw new Error("Install Desktop-owned packages in the local Desktop profile");
   this.descriptions.set(id,info);
   if(info.format==="legacy"&&!this.source(id).approval&&this.inheritedTrust.has(id)&&this.source(id).trustRevoked!==true)this.patchSource(id,{...this.source(id),approval:{trusted:true,version:"legacy",capabilities:[]}});
   if(this.approved(id,info)){
    const bundles=info.format==="legacy"?await compilePlugin(info.serviceEntry!):await compilePackageEntries(info);
    this.bundles.set(id,bundles);
   }else this.bundles.delete(id);
   this.errors.delete(id);
   return info;
  }catch(error){this.bundles.delete(id);this.fail(id,error);throw error;}
 }
 catalog():DesktopPluginCatalogEntry[]{
  const running=new Set(this.runtime.catalog().map(item=>item.id));
  return Object.entries(this.configStore.get().plugins??{}).filter(([,source])=>source.bundled!==true).map(([id,source]):DesktopPluginCatalogEntry=>{
   const info=this.descriptions.get(id);const enabled=source.enabled!==false;const trusted=info?this.approved(id,info):false;
   const waitingReason=this.runtime.waitingReason?.(id);const error=this.errors.get(id);
   const status=!enabled||!this.pluginsEnabled()?"disabled":error?"failed":waitingReason?"waiting":running.has(id)||trusted&&info?.format==="package"&&!info.serviceEntry?"running":this.starting.has(id)?"starting":trusted?"waiting":"disabled";
   return {id,packageId:info?.id??id,owner:"daemon" as const,version:info?.version??"unknown",generation:this.runtime.generation?.(id)??this.epochs.get(id)??0,installed:source.installed!==false,bundled:source.bundled===true,enabled,effectiveEnabled:source.installed!==false&&enabled&&this.pluginsEnabled()&&trusted,source:{type:"directory" as const,path:source.path},format:info?.format??"legacy",metadata:info?.metadata??null,declaredCapabilities:info?.capabilities??[],grantedCapabilities:this.grants(id),trusted,status,error,waitingReason:waitingReason??(enabled&&this.pluginsEnabled()&&!trusted?"Execution trust or capability approval required":undefined),clientBundle:source.installed===false?undefined:this.bundles.get(id)?.clientBundle,revision:this.revision};
  }).sort((a,b)=>a.id.localeCompare(b.id));
 }
 listPlugins():PluginListItem[]{return this.catalog().map(item=>({...item,path:item.source.path}));}
 getLogs(id:string){this.source(id);return this.runtime.getLogs(id);}
 async inspectDirectory(directory:string){const info=await inspectPluginPackage(path.resolve(directory));return{id:info.id,version:info.version,metadata:info.metadata,capabilities:info.capabilities,format:info.format};}
 async installDirectory(input:{path:string;id?:string;trusted?:boolean;enabled?:boolean;approval?:Approval}){
  const directory=path.resolve(input.path);const info=await inspectPluginPackage(directory);const id=PluginIdSchema.parse(input.id??info.id);
  if(info.metadata?.owner==="desktop")throw new Error("Install this package in the local Desktop profile");
  if(input.trusted!==true && !input.approval)throw new Error("Installing executable plugin code requires explicit trust approval");
  const approval=input.approval??{trusted:true as const,version:info.version,capabilities:info.capabilities};
  if(approval.version!==info.version||info.capabilities.some(cap=>!approval.capabilities.includes(cap))||approval.capabilities.some(cap=>!info.capabilities.includes(cap)))throw new Error("Approval must match the inspected version and declared capabilities");
  return this.enqueue(id,async()=>{
   const previous=this.configStore.get().plugins?.[id];
   if(previous&&previous.bundled!==true&&previous.installed!==false)throw new Error(`Plugin ID "${id}" is already configured; choose another ID with --id`);
   this.configStore.patch({plugins:{...this.configStore.get().plugins,[id]:{source:"directory",path:directory,enabled:input.enabled??true,installed:true,approval}}});
   await this.discover(id);if(this.canRun(id))await this.activate(id);this.notify(id);return this.item(id);
  });
 }
 async approvePlugin(id:string,approval:Approval,expectedInstallation:DesktopPluginExpectedInstallation){return this.enqueue(id,async()=>{
  if(this.source(id).path!==expectedInstallation.sourcePath||(this.runtime.generation?.(id)??0)!==expectedInstallation.generation)throw new Error("Plugin installation changed during trust approval");
  const info=await inspectPluginPackage(path.resolve(this.source(id).path));
  if(this.source(id).path!==expectedInstallation.sourcePath||info.id!==expectedInstallation.packageId||(this.runtime.generation?.(id)??0)!==expectedInstallation.generation)throw new Error("Plugin installation changed during trust approval");
  if(approval.version!==info.version||info.capabilities.some(cap=>!approval.capabilities.includes(cap))||approval.capabilities.some(cap=>!info.capabilities.includes(cap)))throw new Error("Approval does not match current package version/capabilities");
  this.patchSource(id,{...this.source(id),approval,trustRevoked:false});this.revoke(id);await this.runtime.stopPluginById(id);await this.discover(id);if(this.canRun(id))await this.activate(id);this.notify(id);return this.catalog().find(item=>item.id===id)!;
 });}
 async revokePluginTrust(id:string){this.patchSource(id,{...this.source(id),trustRevoked:true});this.revoke(id);this.bundles.delete(id);const stopping=this.runtime.stopPluginById(id);return this.enqueue(id,async()=>{await stopping;this.notify(id);return this.catalog().find(item=>item.id===id)!;});}

 async enablePlugin(id:string){if(this.source(id).installed===false)throw new Error("Plugin is not installed");this.patchSource(id,{...this.source(id),enabled:true});return this.enqueue(id,async()=>{if(this.runtime.catalog().some(plugin=>plugin.id===id)&&!this.managementWorkers.has(id)){this.notify(id);return this.item(id);}await this.discover(id);if(this.canRun(id))await this.activate(id);this.notify(id);return this.item(id);});}
 async disablePlugin(id:string){this.patchSource(id,{...this.source(id),enabled:false});this.revoke(id);const stopping=this.runtime.stopPluginById(id);return this.enqueue(id,async()=>{await stopping;this.errors.delete(id);this.notify(id);return this.item(id);});}
 async reloadPlugin(id:string){this.source(id);this.revoke(id);const stopping=this.runtime.stopPluginById(id);return this.enqueue(id,async()=>{await stopping;this.errors.delete(id);await this.discover(id);if(this.canRun(id))await this.activate(id);this.notify(id);return this.item(id);});}
 async removePlugin(id:string){this.source(id);this.revoke(id);const stopping=this.runtime.stopPluginById(id);const plugins={...this.configStore.get().plugins};delete plugins[id];this.configStore.patch({plugins});await this.enqueue(id,async()=>{await stopping;this.runtime.clearLogs(id);this.errors.delete(id);this.descriptions.delete(id);this.bundles.delete(id);this.notify(id);});}
 async invokePluginRpc(id:string,method:string,input:unknown,generation:number){
  this.source(id);
  if(method.startsWith("agent-tool.")||method.startsWith("agent-prompt."))throw new Error("Agent bridge methods require authenticated host caller context");
  if(this.source(id).installed===false)throw new Error("Plugin is not installed");
  const currentGeneration=this.runtime.generation?.(id)??0;
  if(generation!==currentGeneration)throw new Error("Plugin generation is no longer active");
  if(this.canRun(id))return this.runtime.invoke(id,method,input,generation);
  return this.enqueue(id,async()=>{
   const info=this.descriptions.get(id)??await this.discover(id);
   if(this.closing||!this.approved(id,info))throw new Error("Plugin execution trust is required");
   if(!this.managementWorkers.has(id)){
    const epoch=this.epochs.get(id)??0;
    await this.runtime.stopPluginById(id);
    await this.runtime.startPlugin(id,this.source(id).path,()=>!this.closing&&!!this.configStore.get().plugins?.[id]&&this.approved(id,info)&&(this.epochs.get(id)??0)===epoch,info,this.grants(id),"manage",this.bundles.get(id));
    this.managementWorkers.add(id);this.notify(id);
   }
   return this.runtime.invoke(id,method,input,this.runtime.generation?.(id));
  });
 }
 storageGet(id:string,generation?:number){this.source(id);if(generation!==undefined&&generation!==(this.runtime.generation?.(id)??0))throw new Error("Plugin generation is no longer active");return this.data.get(id);}
 storagePatch(id:string,patch:Record<string,unknown>,expectedRevision:number,generation?:number){this.source(id);if(generation!==undefined&&generation!==(this.runtime.generation?.(id)??0))throw new Error("Plugin generation is no longer active");const snapshot=this.data.patch(id,patch,expectedRevision);this.notify(id);return snapshot;}
 secret(id:string,key:string,operation:"configured"|"set"|"delete",value?:string,generation?:number){this.source(id);if(generation!==undefined&&generation!==(this.runtime.generation?.(id)??0))throw new Error("Plugin generation is no longer active");const configured=this.data.secret(id,key,operation,value) as boolean;this.notify(id);return configured;}
 clearData(id:string){PluginIdSchema.parse(id);if(this.canRun(id))throw new Error("Disable plugin before clearing its data");this.data.clear(id);this.notify(id);}
 agentToolDefinitions(agentId:string,turnId:()=>string|null):PaseoToolDefinition[]{
  const definitions:PaseoToolDefinition[]=[];
  for(const [id,tools] of this.agentTools){
   if(!this.canRun(id)||this.managementWorkers.has(id))continue;
   const generation=this.runtime.generation?.(id);
   for(const tool of tools.values()){
    definitions.push({...tool,name:`${id}__${tool.name}`,handler:async(input,context)=>{
     if(context.signal?.aborted)throw new Error("Agent tool was cancelled");
     if(!this.canRun(id))throw new Error("Plugin service is unavailable");
     const result=await this.runtime.invoke(id,`agent-tool.${tool.name}`,{input,agentId,turnId:turnId()},generation);
     if(context.signal?.aborted)throw new Error("Agent tool was cancelled");
     if(result&&typeof result==="object"&&"content" in result&&Array.isArray(result.content))return result as {content:Array<{type:string;[key:string]:unknown}>};
     return {content:[],structuredContent:result};
    }});
   }
  }
  return definitions;
 }
 async agentPromptContributions(agentId:string,turnId:string|null):Promise<PluginAgentPromptSelection[]>{
  const contributions:PluginAgentPromptSelection[]=[];
  for(const [id,hooks] of this.agentPrompts){
   if(!this.canRun(id)||this.managementWorkers.has(id))continue;
   const generation=this.runtime.generation?.(id);
   for(const hook of hooks){
    try{
     const value=await this.runtime.invoke(id,`agent-prompt.${hook}`,{agentId,turnId},generation);
     if(value===null)continue;
     const selection:PluginAgentPromptSelection=typeof value==="string"?{text:value}:value as PluginAgentPromptSelection;
     const ownedTools=this.agentTools.get(id);
     const names=[...(ownedTools?.keys()??[])];
     const toolInstructions=names.map(name=>`Plugin action ${name} is available as the installation-bound native tool ${id}__${name}.`).join("\n");
     contributions.push({...selection,text:[selection.text,toolInstructions].filter(Boolean).join("\n"),tools:selection.tools?.map(name=>ownedTools?.has(name)?`${id}__${name}`:name)});
    }
    catch(error){if(this.canRun(id))this.fail(id,error);}
   }
  }
  return contributions;
 }
 private hostOperation(id:string,operation:string,input:unknown){
  if(operation==="files.sandbox"){
   if(!this.grants(id).includes("files.scoped"))throw new Error("Plugin sandbox files require files.scoped approval");
   const generation=this.getGeneration(id);const epoch=this.epochs.get(id)??0;
   return this.sandboxFiles.invoke(id,generation,input,()=>this.canRun(id)&&this.getGeneration(id)===generation&&(this.epochs.get(id)??0)===epoch);
  }
  const args=input as {patch:Record<string,unknown>;expectedRevision:number;key:string;operation:"get"|"configured"|"set"|"delete";value?:string};
  if(operation==="storage.get")return this.storageGet(id);
  if(operation==="storage.patch")return this.storagePatch(id,args.patch,args.expectedRevision);
  if(operation==="secret")return this.data.secret(id,args.key,args.operation,args.value);
  if(operation==="agent.prompt.register"){
   if(!input||typeof input!=="object"||!("id" in input)||typeof input.id!=="string"||!/^[a-z][a-z0-9._-]*$/.test(input.id))throw new Error("Invalid prompt contribution ID");
   const hooks=this.agentPrompts.get(id)??new Set<string>();if(hooks.has(input.id))throw new Error("Duplicate prompt contribution");hooks.add(input.id);this.agentPrompts.set(id,hooks);return;
  }
  if(operation==="agent.tool.register"){
   const tool=input as {name:string;description:string;inputJsonSchema:Record<string,unknown>};
   if(!/^[a-z][a-z0-9_-]*$/.test(tool.name))throw new Error("Invalid agent tool name");
   const tools=this.agentTools.get(id)??new Map();if(tools.has(tool.name))throw new Error(`Duplicate agent tool: ${tool.name}`);
   tools.set(tool.name,tool);this.agentTools.set(id,tools);return;
  }
  throw new Error(`Host operation is unsupported by daemon: ${operation}`);
 }
 async stopAllPlugins(){this.closing=true;this.globalStartsBlocked=true;this.unsubscribeConfig?.();for(const id of this.epochs.keys())this.revoke(id);this.sandboxFiles.close();await this.runtime.stopAll();await Promise.allSettled(this.operations.values());await this.runtime.stopAll();}
 private canRun(id:string){const source=this.configStore.get().plugins?.[id];const info=this.descriptions.get(id);return !this.closing&&!this.globalStartsBlocked&&this.pluginsEnabled()&&!!source&&source.bundled!==true&&source.installed!==false&&source.enabled!==false&&!!info&&this.approved(id,info);}
 private async activate(id:string){
  if(this.managementWorkers.delete(id))await this.runtime.stopPluginById(id);
  if(this.runtime.catalog().some(item=>item.id===id))return;
  if(this.descriptions.get(id)?.format==="package"&&!this.descriptions.get(id)?.serviceEntry)return;
  const epoch=this.epochs.get(id)??0;this.starting.add(id);this.errors.delete(id);this.notify(id);
  try{await this.runtime.startPlugin(id,this.source(id).path,()=>this.canRun(id)&&(this.epochs.get(id)??0)===epoch,this.descriptions.get(id),this.grants(id),"active",this.bundles.get(id));}
  catch(error){if(this.canRun(id)){this.fail(id,error);throw error;}}
  finally{this.starting.delete(id);this.notify(id);}
 }
 private handleGlobalSwitch(enabled:boolean){this.globalStartsBlocked=!enabled;if(!enabled){for(const id of Object.keys(this.configStore.get().plugins??{}))this.revoke(id);void this.runtime.stopAll().catch(error=>this.logger.error({err:error},"Failed to stop plugins"));}else for(const [id,source] of Object.entries(this.configStore.get().plugins??{})){if(source.bundled===true)continue;void this.enqueue(id,async()=>{await this.discover(id);if(this.canRun(id))await this.activate(id);this.notify(id);}).catch(error=>this.fail(id,error));}for(const [id,source] of Object.entries(this.configStore.get().plugins??{}))if(source.bundled!==true)this.notify(id);}
 private enqueue<T>(id:string,operation:()=>Promise<T>):Promise<T>{const previous=this.operations.get(id)??Promise.resolve();const result=previous.then(operation,operation);this.operations.set(id,result.catch(()=>undefined));return result;}
 private revoke(id:string){this.epochs.set(id,(this.epochs.get(id)??0)+1);this.runtime.invalidateGeneration?.(id);this.sandboxFiles.revoke(id);this.starting.delete(id);this.managementWorkers.delete(id);this.agentTools.delete(id);this.agentPrompts.delete(id);}
 private source(id:string):PluginSource{PluginIdSchema.parse(id);const source=this.configStore.get().plugins?.[id];if(!source)throw new Error(`Plugin is not configured: ${id}`);if(source.bundled===true)throw new Error(`Plugin must be installed explicitly from a folder: ${id}`);return source;}
 private patchSource(id:string,source:PluginSource){this.configStore.patch({plugins:{...this.configStore.get().plugins,[id]:source}});}
 private item(id:string){const item=this.listPlugins().find(item=>item.id===id);if(!item)throw new Error(`Plugin is not configured: ${id}`);return item;}
 private fail(id:string,error:unknown){this.revoke(id);this.errors.set(id,error instanceof Error?error.message:String(error));void this.runtime.stopPluginById(id).catch(stopError=>this.logger.error({err:stopError,pluginId:id},"Failed to stop failed plugin"));this.notify(id);}
 private notify(id:string){this.revision++;for(const listener of this.listeners)listener(id);}
}

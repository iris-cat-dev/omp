import type { DaemonClient } from "./daemon-client.js";
import type { DesktopPluginCatalogEntry, DesktopPluginMetadata, DesktopPluginExpectedInstallation } from "@omp-desktop/protocol/desktop-plugins";
import type { PluginListItem, PluginLogEntry } from "@omp-desktop/protocol/messages";
export interface PluginCatalogSnapshot { plugins:DesktopPluginCatalogEntry[];revision:number;pluginsEnabled:boolean }
export interface PluginConfigurationSnapshot {revision:number;values:Record<string,unknown>}
export interface PluginApproval {trusted:true;version:string;capabilities:string[]}
export type PluginExpectedInstallation=DesktopPluginExpectedInstallation;
export interface DesktopPluginActions {
 catalog():Promise<PluginCatalogSnapshot>;
 subscribe(handler:(snapshot:PluginCatalogSnapshot)=>void):Promise<()=>void>;
 list():Promise<PluginListItem[]>;
 inspect(path:string):Promise<{id:string;version?:string;metadata?:DesktopPluginMetadata|null;capabilities?:string[];format?:"legacy"|"package"}>;
 install(input:{path:string;id?:string;trusted?:boolean;enabled?:boolean;approval?:PluginApproval}):Promise<PluginListItem>;
 approve(id:string,approval:PluginApproval,expectedInstallation:PluginExpectedInstallation):Promise<DesktopPluginCatalogEntry>;
 revokeTrust(id:string):Promise<DesktopPluginCatalogEntry>;
 enable(id:string):Promise<PluginListItem>;disable(id:string):Promise<PluginListItem>;reload(id:string):Promise<PluginListItem>;remove(id:string):Promise<void>;
 logs(id:string):Promise<PluginLogEntry[]>;
 invoke(id:string,method:string,input:unknown,generation:number):Promise<unknown>;
 configuration:{get(id:string,generation:number):Promise<PluginConfigurationSnapshot>;patch(id:string,fields:Record<string,unknown>,expectedRevision:number,generation:number):Promise<PluginConfigurationSnapshot>};
 secrets:{configured(id:string,key:string,generation:number):Promise<boolean>;set(id:string,key:string,value:string,generation:number):Promise<void>;delete(id:string,key:string,generation:number):Promise<void>};
 clearData(id:string):Promise<void>;
}
export function createDesktopPluginActions(client:DaemonClient):DesktopPluginActions {
 return {
  catalog:()=>client.getPluginCatalogSnapshot(),
  revokeTrust:id=>client.revokePluginTrust(id),
  async subscribe(handler){
   let active=true;let revision=-1;let pending=Promise.resolve();
   const publish=async()=>{const snapshot=await client.getPluginCatalogSnapshot();if(active&&snapshot.revision>revision){revision=snapshot.revision;handler(snapshot);}};
   const unsubscribe=client.on("status",message=>{if(message.payload.status==="server_info")revision=-1;if(message.payload.status==="plugin_catalog_changed"||message.payload.status==="server_info")pending=pending.then(publish).catch(error=>{if(active)console.error("Plugin catalog subscription failed",error);});});
   try{await publish();}catch(error){active=false;unsubscribe();throw error;}
   return()=>{active=false;unsubscribe();};
  },
  list:()=>client.listPlugins(),inspect:directory=>client.inspectDirectoryPlugin(directory),install:({path,id,...options})=>client.installDirectoryPlugin(path,id,options),approve:(id,approval,expectedInstallation)=>client.approvePlugin(id,approval,expectedInstallation),enable:id=>client.enablePlugin(id),disable:id=>client.disablePlugin(id),reload:id=>client.reloadPlugin(id),remove:id=>client.removePlugin(id),logs:id=>client.getPluginLogs(id),invoke:(id,method,input,generation)=>client.invokePluginRpc(id,method,input,generation),
  configuration:{get:(id,generation)=>client.getPluginStorage(id,generation),patch:(id,fields,revision,generation)=>client.patchPluginStorage(id,fields,revision,generation)},
  secrets:{configured:(id,key,generation)=>client.setPluginSecret(id,key,"configured",undefined,generation),set:async(id,key,value,generation)=>{await client.setPluginSecret(id,key,"set",value,generation);},delete:async(id,key,generation)=>{await client.setPluginSecret(id,key,"delete",undefined,generation);}},clearData:id=>client.clearPluginData(id),
 };
}

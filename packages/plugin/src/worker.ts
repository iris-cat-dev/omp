import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PluginInstallation } from "./runtime-contracts.js";
import type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
import { isPluginReleaseOperation } from "./native-cleanup.js";
import { PluginLogRedactor } from "./log-redaction.js";
import { PluginOutputCapture } from "./worker-output.js";
export { PluginOutputCapture } from "./worker-output.js";
export type { PluginProcessMessage, PluginProcessRequest } from "./plugin-process-protocol.js";
export { createPluginDaemonTransportFactory } from "./daemon-transport.js";
export function getPluginWorkerUrl(){return new URL(import.meta.url.endsWith(".ts")?"./worker-process.ts":"./worker-process.js",import.meta.url);}
export interface IsolatedPluginWorkerOptions {
 installation:PluginInstallation;serverBundle:string;serviceEntry:string;mode:"active"|"manage";
 /** Source format determines compatibility; package versions never grant legacy authority. */
 format:"legacy"|"package";
 /** Cancels an initialization that has not yet returned its cleanup handle. */
 signal?:AbortSignal;
 hostCall(operation:string,input:unknown):unknown|Promise<unknown>;
 onLog?(stream:"stdout"|"stderr",message:string):void;
 onFailure?(error:Error):void;
 onWaiting?(reason:string|null):void;
}
export class IsolatedPluginWorker {
 private readonly child;
 private stopped=false;
 private readonly pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
 private readonly ready=Promise.withResolvers<void>();
 private methods=new Set<string>();
 private stopping:Promise<void>|undefined;
 private readonly logRedactor=new PluginLogRedactor();
 private constructor(private readonly options:IsolatedPluginWorkerOptions){
  this.child=fork(fileURLToPath(getPluginWorkerUrl()),[],{serialization:"advanced",stdio:["ignore","pipe","pipe","ipc"],env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:"1"}:{})},execArgv:import.meta.url.endsWith(".ts")?["--experimental-strip-types","--import",`data:text/javascript,${encodeURIComponent('import {register} from "node:module"; register('+JSON.stringify(new URL("./worker-loader.ts",import.meta.url).href)+');')}`]:[]});
  new PluginOutputCapture(this.child,(stream,message,truncated)=>options.onLog?.(stream,this.logRedactor.redact(message,truncated)));
  this.child.on("message",raw=>this.receive(raw as PluginProcessMessage));
  this.child.on("error",error=>{this.ready.reject(error);if(!this.stopped){options.onFailure?.(error);void this.stop();}});
  this.child.on("close",()=>{const expected=this.stopped;this.stopped=true;const error=new Error("Plugin worker exited");this.ready.reject(error);for(const call of this.pending.values()){clearTimeout(call.timer);call.reject(error);}this.pending.clear();if(!expected)options.onFailure?.(error);});
  this.send({type:"initialize",pluginId:options.installation.id,bundle:options.serverBundle,serviceEntry:options.serviceEntry,format:options.format,installation:options.installation,mode:options.mode});
 }
 private send(message:PluginProcessRequest):void {
  const fail=(error:Error)=>{this.ready.reject(error);if(!this.stopped){this.options.onFailure?.(error);void this.stop();}};
  if(!this.child.connected){fail(new Error("Plugin worker IPC channel is closed"));return;}
  try { this.child.send(message,error=>{if(error)fail(error);}); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
 }
 static async start(options:IsolatedPluginWorkerOptions){
  if(options.signal?.aborted)throw new Error("Plugin generation is no longer active");
  const worker=new IsolatedPluginWorker(options);
  const deadline=Promise.withResolvers<void>();
  const timer=setTimeout(()=>deadline.reject(new Error("Plugin initialization timed out")),30_000);
  const abort=()=>{worker.ready.reject(new Error("Plugin generation is no longer active"));void worker.stop();};
  options.signal?.addEventListener("abort",abort,{once:true});
  if(options.signal?.aborted)abort();
  try{await Promise.race([worker.ready.promise,deadline.promise]);return worker;}
  catch(error){await worker.stop();throw error;}
  finally{clearTimeout(timer);options.signal?.removeEventListener("abort",abort);}
 }
 private receive(message:PluginProcessMessage){
  if(message.type==="ready"){this.methods=new Set(message.methods);this.ready.resolve();return;}
  if(message.type==="fatal"){const error=new Error(this.logRedactor.redact(message.error));this.ready.reject(error);this.options.onFailure?.(error);void this.stop();return;}
  if(message.type==="waiting"){this.options.onWaiting?.(message.reason?this.logRedactor.redact(message.reason):null);return;}
  if(message.type==="host_call"){
   const releaseOnly=isPluginReleaseOperation(message.operation,message.input);
   void Promise.resolve().then(()=>{if(this.stopped&&!releaseOnly)throw new Error("Plugin generation is no longer active");if(message.operation==="secret")this.logRedactor.rememberSecret(message.input);return this.options.hostCall(message.operation,message.input);}).then(output=>{if(message.operation==="secret")this.logRedactor.rememberSecret(message.input,output);if(!this.stopped||releaseOnly)this.send({type:"host_result",requestId:message.requestId,output});},error=>{if(!this.stopped||releaseOnly)this.send({type:"host_result",requestId:message.requestId,error:this.logRedactor.redact(error instanceof Error?error.message:String(error))});});return;
  }
  if(message.type==="result"||message.type==="error"){const call=this.pending.get(message.requestId);if(!call)return;this.pending.delete(message.requestId);clearTimeout(call.timer);if(message.type==="error")call.reject(new Error(this.logRedactor.redact(message.error)));else call.resolve(message.output);}
 }
 invoke(method:string,input:unknown,generation:number):Promise<unknown>{
  if(this.stopped||generation!==this.options.installation.generation)return Promise.reject(new Error("Plugin generation is no longer active"));
  if(!this.methods.has(method))return Promise.reject(new Error(`Unknown plugin RPC: ${method}`));
  const requestId=randomUUID();const {promise,resolve,reject}=Promise.withResolvers<unknown>();
  const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error("Plugin RPC timed out"));},30_000);
  this.pending.set(requestId,{resolve,reject,timer});this.send({type:"invoke",requestId,method,input});return promise;
 }
 emit(event:string,payload:unknown){if(!this.stopped)this.send({type:"host_event",event,payload});}
 stop():Promise<void>{
  if(this.stopping)return this.stopping;
  this.stopped=true;
  for(const call of this.pending.values()){clearTimeout(call.timer);call.reject(new Error("Plugin stopped"));}
  this.pending.clear();
  this.stopping=(async()=>{
   if(this.child.exitCode!==null||this.child.signalCode!==null)return;
   const {promise,resolve}=Promise.withResolvers<void>();
   this.child.once("close",resolve);
   const timer=setTimeout(()=>{this.child.kill("SIGKILL");resolve();},3_000);
   try {
    if(this.child.connected)this.child.send({type:"shutdown"} satisfies PluginProcessRequest,error=>{if(error)this.child.kill("SIGKILL");});
   } catch { this.child.kill("SIGKILL"); }
   await promise;
   clearTimeout(timer);
  })();
  return this.stopping;
 }
}

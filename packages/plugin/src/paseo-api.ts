import type { PaseoApi } from "@omp-desktop/client";
import type { PluginInstallation } from "./runtime-contracts.js";
import type { PluginActivationScope } from "./activation.js";
export function createPluginPaseoApi(api:PaseoApi,installation:PluginInstallation,scope:PluginActivationScope,options:{mode:"manage"|"active";legacy?:boolean}):PaseoApi {
 const proxies=new WeakMap<object,object>();
 const subscriptions=new WeakMap<object,()=>void|Promise<void>>();
 const capability=(path:readonly string[])=>{
  const method=path.at(-1);
  if(method==="respondToPermission")return "agents.permissions";
  if(method==="create" || method==="open")return "agents.create";
  if(method==="send" || method==="run" || method==="stop" || method==="compact" || method==="setModel" || method==="setTitle" || method==="archive" || method==="detach")return "agents.prompt";
  return "agents.events";
 };
 const wrap=(value:unknown,path:readonly string[]):unknown=>{
  if(value===null || typeof value!=="object")return value;
  const existing=proxies.get(value);if(existing)return existing;
  const proxy=new Proxy(value,{
   get(target,key){
    if(key==="unsubscribe" && subscriptions.has(target))return subscriptions.get(target);
    scope.assertCurrent(installation.generation);
    if(typeof key!=="string")return Reflect.get(target,key);
    if(["close","dispose","disconnect","connect","ensureConnected"].includes(key))throw new Error("Plugin does not own the host connection");
    if(!options.legacy && path.length===0 && ["config","omp","forgeAuth","plugins"].includes(key))throw new Error(`Global host API is unavailable to plugin: ${key}`);
    const member=Reflect.get(target,key,target);const next=[...path,key];
    if(typeof member!=="function")return wrap(member,next);
    return (...args:unknown[])=>{
     scope.assertCurrent(installation.generation);
     if(options.mode!=="active")throw new Error("Agent operations are unavailable in management mode");
     const required=capability(next);
     if(!options.legacy && (!installation.declaredCapabilities.includes(required)||!installation.grantedCapabilities.includes(required)))throw new Error(`Plugin capability is not granted: ${required}`);
     const guarded=args.map(argument=>typeof argument==="function"?(...values:unknown[])=>{if(scope.signal.aborted)return;scope.assertCurrent(installation.generation);return argument(...values);}:argument);
     const result=Reflect.apply(member,target,guarded);
     if(typeof result==="function")return scope.own(()=>result());
     if(result instanceof Promise)return result.then(async resolved=>{
      const unsubscribe=resolved&&typeof resolved==="object"&&typeof resolved.unsubscribe==="function"?resolved.unsubscribe:undefined;
      if(scope.signal.aborted){if(unsubscribe)await unsubscribe();scope.assertCurrent(installation.generation);}
      scope.assertCurrent(installation.generation);
      if(unsubscribe)subscriptions.set(resolved,scope.own(unsubscribe));
      return wrap(resolved,next);
     });
     return wrap(result,next);
    };
   },
  });
  proxies.set(value,proxy);return proxy;
 };
 return wrap(api,[]) as PaseoApi;
}

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier:string,context:{parentURL?:string},nextResolve:(specifier:string,context:unknown)=>Promise<unknown>){
 if(context.parentURL?.startsWith("file:")&&specifier.startsWith(".")&&specifier.endsWith(".js")){
  const url=new URL(specifier.replace(/\.js$/,".ts"),context.parentURL);
  if(existsSync(fileURLToPath(url)))return{url:url.href,shortCircuit:true};
 }
 return nextResolve(specifier,context);
}

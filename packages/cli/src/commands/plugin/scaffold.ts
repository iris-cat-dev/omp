import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginIdSchema } from "@omp-desktop/protocol/messages";
const TSCONFIG={compilerOptions:{target:"ES2020",module:"ESNext",moduleResolution:"Bundler",lib:["ES2023","DOM"],jsx:"react-jsx",strict:true,skipLibCheck:true,noEmit:true,esModuleInterop:true,allowSyntheticDefaultImports:true},include:["**/*.ts","**/*.tsx"]};
const ENTRY=`import type { PluginContext } from "@omp-desktop/plugin";
import { MainSurface } from "./main.client";
export default function contribute(plugin: PluginContext) {
  plugin.addSurface("main", MainSurface);
  plugin.addSidebarItem({id:"main",title:"My plugin",icon:"puzzle",surface:"main"});
  return () => {};
}
`;
const CLIENT_SURFACE=`import type { PluginSurfaceProps } from "@omp-desktop/plugin";
import React from "react";
import { Text, View } from "react-native";
export function MainSurface({theme,layout}:PluginSurfaceProps) {
  return <View style={{flex:1,padding:layout.compact?16:24,backgroundColor:theme.colors.surface0}}><Text style={{color:theme.colors.foreground}}>Hello from my plugin</Text></View>;
}
`;
export interface PluginScaffold {id:string;directory:string}
export async function scaffoldPluginDirectory(targetDirectory:string,requestedId?:string):Promise<PluginScaffold> {
 const directory=path.resolve(targetDirectory);const id=PluginIdSchema.parse(requestedId??path.basename(directory));
 await mkdir(directory,{recursive:true});if((await readdir(directory)).length)throw new Error(`Plugin directory must be empty: ${directory}`);
 const packageJson={name:id,private:true,version:"0.0.0",scripts:{typecheck:"tsc --noEmit"},devDependencies:{"@omp-desktop/plugin":"^0.6.1","@omp-desktop/client":"^0.6.1","@omp-desktop/protocol":"^0.6.1","@tanstack/react-query":"^5.90.11","@types/react":"~19.2.0",react:"19.1.0","react-native":"0.81.5",typescript:"^5.9.3",zod:"^4.4.3"}};
 const files=new Map<string,string>([["paseo-plugin.json",JSON.stringify({id},null,2)+"\n"],["package.json",JSON.stringify(packageJson,null,2)+"\n"],["tsconfig.json",JSON.stringify(TSCONFIG,null,2)+"\n"],["index.ts",ENTRY],["main.client.tsx",CLIENT_SURFACE]]);
 await Promise.all([...files].map(([filename,contents])=>writeFile(path.join(directory,filename),contents,{flag:"wx"})));
 return {id,directory};
}

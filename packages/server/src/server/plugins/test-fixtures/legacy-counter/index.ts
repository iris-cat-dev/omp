import type {PluginContext} from "@omp-desktop/plugin";
import {CounterView} from "./counter.client";
import {createCounterHandler,searchCounter} from "./counter.server";
import {count,search} from "./counter.shared";
export default function contribute(plugin:PluginContext){
 const cleanups:Array<()=>void>=[];
 plugin.handle(count,createCounterHandler(cleanups));
 plugin.handle(search,searchCounter);
 plugin.addSurface("counter",CounterView);
 plugin.addSidebarItem({id:"counter",title:"Legacy counter",icon:"plus",surface:"counter"});
 plugin.addWorkspacePanel({id:"counter-workspace",title:"Counter",icon:"plus",context:"workspace",Component:CounterView});
 plugin.addWorkspacePanel({id:"counter-agent",title:"Counter",icon:"plus",context:"agent",Component:CounterView});
 plugin.addCommandCenterItem({id:"open-counter",title:"Open counter",icon:"plus",context:"global",onSelect:context=>context.openSurface("counter")});
 plugin.addAttachmentSource({id:"counter-snapshot",title:"Counter snapshot",icon:"paperclip",pickerTitle:"Counter snapshots",searchPlaceholder:"Search snapshots",search});
 plugin.addTheme({id:"counter-dark",name:"Counter dark",appearance:"dark",colors:{background:"#101923",foreground:"#f1f5f9",raised:"#182431",control:"#213247",border:"#3b5068",accent:"#56b4ee",mutedForeground:"#9aacc0",ring:"#56b4ee"}});
 return ()=>{for(const cleanup of cleanups.reverse())cleanup();};
}

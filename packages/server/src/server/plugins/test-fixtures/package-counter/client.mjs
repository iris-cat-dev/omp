import React,{useState} from 'react';
import {Text,View,Pressable} from 'react-native';
import {useRpc,defineRpc} from '@omp-desktop/plugin';
import {z} from 'zod';
const counter=defineRpc({name:'counter.increment',input:z.object({by:z.number().int().default(1)}),output:z.object({count:z.number().int()})});
function Counter(){const rpc=useRpc(counter);const [count,setCount]=useState(0);const [error,setError]=useState(null);return React.createElement(View,{style:{padding:24,gap:12}},React.createElement(Text,null,`Packaged counter: ${count}`),React.createElement(Pressable,{accessibilityRole:'button',onPress:()=>rpc({by:1}).then(value=>{setCount(value.count);setError(null);},reason=>setError(String(reason)))},React.createElement(Text,null,'Increment')),error&&React.createElement(Text,null,error));}
export default function setup(ctx){ctx.addSettingsPage({id:'configuration',title:'Packaged counter',Component:Counter});if(ctx.mode==='active'){ctx.addSurface('counter',Counter);ctx.addSidebarItem({id:'counter',title:'Packaged counter',icon:'plus',surface:'counter'});ctx.addWorkspacePanel({id:'counter',title:'Counter',icon:'plus',context:'workspace',Component:Counter});} }

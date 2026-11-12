import React,{useState} from "react";
import {Text,View,Pressable} from "react-native";
import {useRpc,type PluginHostProps} from "@omp-desktop/plugin";
import {count} from "./counter.shared";
export function CounterView({theme}:PluginHostProps){const invoke=useRpc(count);const [value,setValue]=useState(0);const [error,setError]=useState<string|null>(null);return <View style={{padding:24,gap:12,backgroundColor:theme.colors.surface0}}><Text style={{color:theme.colors.foreground,fontSize:24}}>Legacy counter: {value}</Text><Pressable accessibilityRole="button" onPress={()=>void invoke({by:1}).then(result=>{setValue(result.count);setError(null);},reason=>setError(String(reason)))}><Text style={{color:theme.colors.accent}}>Increment</Text></Pressable>{error&&<Text style={{color:theme.colors.statusDanger}}>{error}</Text>}</View>;}

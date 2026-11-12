import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Image, Linking } from 'react-native';
import type { PluginClientContext, PluginHostProps } from '@omp-desktop/plugin';
import { z } from 'zod';
import { status, action, exportAccess, StatusSchema } from './rpc.ts';
import { StateSchema, ConfigSchema, AccessSchema, listKey, type State } from './state.ts';
import type { PairPurpose } from './shared/pairing-protocol.ts';
import { prepareDshImport } from './importer.ts';
import { parseConfigDraft, editSandboxPath, editSandboxCapability } from './shared/config-draft.ts';
const connectionLabels = { waiting: '等待连接', connecting: '正在连接', ready: '已连接', failed: '连接失败' } as const;
export default function setup(ctx: PluginClientContext) {
  const Page = (props: PluginHostProps) => <QQPage context={ctx} {...props} />;
  ctx.addSettingsPage({ id: 'qqbot.settings', title: 'QQ 连接', icon: 'message-circle', Component: Page });
  ctx.addSurface('qqbot', Page);
  ctx.addSidebarItem({ id: 'qqbot', title: 'QQ 连接', icon: 'message-circle', surface: 'qqbot' });
  ctx.addWorkspacePanel({ id: 'qqbot.peer', title: 'QQ 连接', icon: 'message-circle', context: 'agent', Component: props => <QQPage {...props} context={ctx} filterAgentId={props.agentId} /> });
  ctx.addCommandCenterItem({ id: 'qqbot.open', title: 'QQ 连接设置', icon: 'message-circle', context: 'global', onSelect: command => command.openSurface('qqbot') });
}
function QQPage({ context: ctx, theme, filterAgentId }: PluginHostProps & { context: PluginClientContext; filterAgentId?: string }) {
  const [snapshot,setSnapshot] = useState<z.infer<typeof StatusSchema> | null>(null);
  const [state,setState] = useState<State>(() => StateSchema.parse({}));
  const [error,setError] = useState<string | null>(null);
  const [connectionError,setConnectionError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [appId,setAppId] = useState(''); const [secret,setSecret] = useState('');
  const [configText,setConfigText] = useState('');
  const [purpose,setPurpose] = useState<PairPurpose>('allow-c2c'); const [entries,setEntries] = useState(''); const [exportText,setExportText] = useState('');
  const [importDocument,setImportDocument] = useState(''); const [importSecret,setImportSecret] = useState(false);
  const dirty=useRef({account:false,config:false});
  const load = useCallback(async (updateDraft = false) => {
    const stored = await ctx.storage.get(); if (ctx.signal.aborted) return; const parsed = StateSchema.parse(stored.values); setState(parsed);
    const live = await ctx.rpc(status,{}); if (ctx.signal.aborted) return; setSnapshot(live);setConnectionError(null);
    if(updateDraft)dirty.current={account:false,config:false};
    if(!dirty.current.config)setConfigText(JSON.stringify(live.config,null,2));
    if(!dirty.current.account)setAppId(live.appId);
  },[ctx]);
  useEffect(() => { let closed = false; let timer: ReturnType<typeof setTimeout>|undefined; const poll = async () => { try { await load(false); } catch (e) { if (!closed&&!ctx.signal.aborted) setConnectionError(e instanceof Error ? e.message : String(e)); } if (!closed && !ctx.signal.aborted) timer = setTimeout(poll,2000); }; void load(true).then(() => { if (!closed&&!ctx.signal.aborted) timer = setTimeout(poll,2000); },e => { if (!closed&&!ctx.signal.aborted) { setConnectionError(String(e)); timer = setTimeout(poll,2000); } }); return () => { closed = true; clearTimeout(timer); }; },[ctx,load]);
  const run = (fn: () => Promise<unknown>) => { if (busy || ctx.signal.aborted) return; setBusy(true); setError(null); void fn().then(() => load(false)).catch(e => { if(!ctx.signal.aborted)setError(e instanceof Error && e.message.includes('CONFLICT') ? '账号或访问权限已被修改。请刷新后重新确认，未覆盖新设置。' : e instanceof Error ? e.message : String(e)); }).finally(() => {if(!ctx.signal.aborted)setBusy(false);}); };
  const invoke = (value: z.input<typeof action.input>) => run(async () => { const result = await ctx.rpc(action,value); if(!ctx.signal.aborted)setSnapshot(result); });
  const c = theme.colors;
  const button = (label: string, onPress: () => void, danger = false) => <Pressable accessibilityRole="button" disabled={busy} onPress={onPress} style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 7, backgroundColor: danger ? c.statusDanger : c.accent, opacity: busy ? 0.5 : 1 }}><Text style={{ color: c.accentForeground, fontWeight: '600' }}>{label}</Text></Pressable>;
  const inputStyle = { borderWidth: 1, borderColor: c.foregroundMuted, borderRadius: 7, padding: 10, color: c.foreground, backgroundColor: c.surface0 };
  const peers = (snapshot?.peers ?? Object.values(state.peers)).filter(p => !filterAgentId || p.agentId === filterAgentId);
  const access = snapshot?.access ?? state.access;
  const configDraft = parseConfigDraft(configText);
  const accessEdit = (field: 'c2cMode'|'groupMode'|'commandMode', mode: 'open'|'allowlist'|'disabled') => {
    const updated = AccessSchema.parse({ ...access,[field]:mode });
    invoke({kind:'access',access:updated,accessRevision:access.revision});
  };
  const connectionLabel = ctx.mode === 'manage' ? '执行已禁用' : connectionError ? '读取失败' : snapshot ? connectionLabels[snapshot.connection] : '正在读取';
  return <ScrollView contentContainerStyle={{ padding: 20, gap: 20, maxWidth: 920 }} style={{ backgroundColor: c.surface0 }}>
    <View style={{ gap: 8 }}>
      <Text style={{fontSize:24,fontWeight:'700',color:c.foreground}}>QQ 连接</Text>
      <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:12}}>
        <Text testID="qqbot-connection-status" style={{color:connectionError||snapshot?.connection==='failed'?c.statusDanger:c.foregroundMuted}}>连接状态：{connectionLabel}</Text>
        {ctx.mode==='active'?button('重启 QQ 连接',() => invoke({kind:'restart'})):null}
      </View>
      {ctx.mode==='manage'?<Text style={{color:c.foregroundMuted}}>可配置账号与访问权限。扫码轮询只在 daemon 执行。</Text>:snapshot?.reason?<Text style={{color:snapshot.connection==='failed'?c.statusDanger:c.foregroundMuted}}>{snapshot.reason}</Text>:null}
    </View>
    {error||connectionError ? <Text accessibilityRole="alert" style={{color:c.statusDanger}}>{error??connectionError}</Text> : null}
    <View style={{gap:10}}><Text style={{fontSize:18,fontWeight:'600',color:c.foreground}}>机器人账号</Text><Text style={{color:c.foregroundMuted}}>当前 AppID：{snapshot?.appId||'未绑定'}</Text><TextInput accessibilityLabel="QQ AppID" placeholder="AppID" value={appId} onChangeText={value=>{dirty.current.account=true;setAppId(value);}} style={inputStyle}/><TextInput accessibilityLabel="QQ AppSecret" placeholder={snapshot?.secretConfigured ? 'AppSecret 已保存；输入新值可替换' : 'AppSecret（仅写入 daemon secret 存储）'} value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" style={inputStyle}/>
    <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>{button('保存／替换账号',() => run(async () => { if (!appId.trim()) throw new Error('请填写 AppID'); const credentialKey=secret?`credential-draft:${crypto.randomUUID()}`:undefined; try { if (credentialKey) { await ctx.secrets.set(credentialKey,secret); setSecret(''); } await ctx.rpc(action,{kind:'replace',appId:appId.trim(),credentialKey,accessRevision:access.revision});dirty.current.account=false; } finally { if(credentialKey) await ctx.secrets.delete(credentialKey); } }))}{button('扫码绑定',() => invoke({kind:'bind'}))}{button('刷新二维码',() => invoke({kind:'refresh'}))}{button('解绑',() => invoke({kind:'unbind',accessRevision:access.revision}),true)}{button('刷新状态',() => run(() => load(true)))}</View>
    {snapshot?.binding.qrSvg ? <Image accessibilityLabel="QQ 绑定二维码" source={{uri:snapshot.binding.qrSvg}} style={{width:220,height:220,backgroundColor:'#fff'}}/> : null}
    {snapshot?.binding.url ? button('打开绑定链接',() => { void Linking.openURL(snapshot.binding.url!); }) : null}
    {snapshot?.binding.phase === 'failed' ? <Text style={{color:c.statusDanger}}>{snapshot.binding.reason}</Text> : null}</View>
    <View style={{gap:12}}><Text style={{fontSize:18,fontWeight:'600',color:c.foreground}}>访问权限</Text>{([['私聊','c2cMode'],['群聊','groupMode'],['斜杠命令（按发送者）','commandMode']] as const).map(([title,field]) => <View key={field} style={{gap:6}}><Text style={{color:c.foreground}}>{title} · {access[field]}</Text><View style={{flexDirection:'row',gap:8}}>{(['open','allowlist','disabled'] as const).map((mode,i) => <React.Fragment key={mode}>{button(['所有人','仅名单','关闭'][i]!,() => accessEdit(field,mode))}</React.Fragment>)}</View></View>)}
    <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>{(['allow-c2c','allow-group','owner'] as const).map((p,i) => <React.Fragment key={p}>{button(['私聊名单','群名单','命令名单'][i]!,() => setPurpose(p))}</React.Fragment>)}</View><Text style={{color:c.foreground}}>当前：{purpose} · 访问修订 {access.revision}</Text>
    {access[listKey(purpose)].map(member => <View key={member.openid} style={{gap:5}}><Text selectable style={{color:c.foreground}}>{member.nickname || member.sceneName || '未命名'} · {member.openid}</Text><View style={{flexDirection:'row',gap:8}}>{button('撤销',() => invoke({kind:'revoke',purpose,openid:member.openid,accessRevision:access.revision}),true)}</View></View>)}
    <TextInput accessibilityLabel="OpenID 与昵称名单" multiline placeholder="每行 OpenID:昵称" value={entries} onChangeText={setEntries} style={inputStyle}/><View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>{button('添加／修改昵称',() => invoke({kind:'manual',purpose,text:entries,accessRevision:access.revision}))}{ctx.mode==='active'?button('生成配对码',() => invoke({kind:'pair',purpose,accessRevision:access.revision})):null}{button('导出名单',() => run(async()=>{const result=await ctx.rpc(exportAccess,{purpose,accessRevision:access.revision});if(!ctx.signal.aborted)setExportText(result.text);} ))}</View>{ctx.mode==='manage'?<Text style={{color:c.foregroundMuted}}>启用 QQ 网关后可以生成配对码；禁用时仍可手动维护和导出名单。</Text>:null}
    {snapshot?.challenges.filter(ch => ch.purpose === purpose).map(ch => <View key={ch.code} style={{gap:5}}><Text selectable style={{color:c.foreground,fontSize:20,fontWeight:'600'}}>{ch.code}</Text><Text style={{color:c.foregroundMuted}}>在目标 QQ 对话内发送；{new Date(ch.expiresAt).toLocaleTimeString()} 过期 · 已认领 {ch.claims.length}</Text>{button('结束配对',() => invoke({kind:'end-pair',code:ch.code}))}</View>)}{exportText ? <TextInput accessibilityLabel="导出的名单" multiline editable={false} value={exportText} style={inputStyle}/> : null}</View>
    <View style={{gap:10}}>
      <Text style={{fontSize:18,fontWeight:'600',color:c.foreground}}>QQ 强制沙箱</Text>
      <Text style={{color:c.foregroundMuted}}>默认仅能读写此目录内的文件。可显式开启隔离 JavaScript、公网请求和主机生图；系统命令、系统身份、其他宿主工具与 skill 始终禁用。保存目录或能力变更会停止旧 agent 并创建新对话，Desktop 历史保留。</Text>
      <TextInput accessibilityLabel="QQ 沙箱路径" placeholder="留空使用此安装实例的专用私有目录" value={configDraft?.sandboxPath ?? ''} editable={!!configDraft&&!busy} autoCapitalize="none" onChangeText={value=>{dirty.current.config=true;setConfigText(editSandboxPath(configText,value));}} style={inputStyle}/>
      <Text style={{color:c.foregroundMuted}}>支持绝对路径或 ~/路径；不能使用用户主目录、文件系统根目录或符号链接。路径与能力开关使用下方同一份 JSON 草稿。</Text>
      {configDraft ? <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>
        {button(`JavaScript：${configDraft.sandboxCapabilities.javascript ? '开启' : '关闭'}`,()=>{dirty.current.config=true;setConfigText(editSandboxCapability(configText,'javascript',!configDraft.sandboxCapabilities.javascript));})}
        {button(`公网请求：${configDraft.sandboxCapabilities.network ? '开启' : '关闭'}`,()=>{dirty.current.config=true;setConfigText(editSandboxCapability(configText,'network',!configDraft.sandboxCapabilities.network));})}
        {button(`主机生图：${configDraft.sandboxCapabilities.imageGeneration ? '开启' : '关闭'}`,()=>{dirty.current.config=true;setConfigText(editSandboxCapability(configText,'imageGeneration',!configDraft.sandboxCapabilities.imageGeneration));})}
      </View> : <Text style={{color:c.statusDanger}}>请先修正下方配置 JSON，再编辑沙箱路径与能力。</Text>}
      <Text style={{color:c.foregroundMuted}}>开启公网请求后，获准 QQ 用户可将沙箱数据发送到任意公网地址；仍禁止私网、localhost、云元数据与宿主凭据。</Text>
      <Text style={{color:c.foregroundMuted}}>主机生图使用 Desktop 已配置的生图模型与凭据，可能产生模型费用；输入图片与生成产物仅限 QQ 沙箱。成功生成的图片自动发送到当前获准 QQ 对话，不需要开启 sendPresentedFiles，也不需要开启公网请求。</Text>
    </View>
    <View style={{gap:10}}><Text style={{fontSize:18,fontWeight:'600',color:c.foreground}}>对话与具名 preset</Text><Text style={{color:c.foregroundMuted}}>保留模型、thinking 与 prompt 偏好；下一次 /new 或 /reset 生效。mode 固定为 ask，不能通过 preset 关闭沙箱或配置 MCP、宿主 tools、skills 与运行选项。sendFile.extraRoots 不扩大沙箱；sendPresentedFiles 默认为 false，仅显式开启后投递沙箱内文件。</Text><TextInput accessibilityLabel="QQ 配置 JSON" multiline value={configText} onChangeText={value=>{dirty.current.config=true;setConfigText(value);}} style={[inputStyle,{minHeight:280,fontFamily:'monospace'}]}/>{button('保存配置',() => run(async () => { const config = ConfigSchema.parse(JSON.parse(configText)); await ctx.rpc(action,{kind:'configure',config,accessRevision:access.revision});dirty.current.config=false; }))}</View>
    <View style={{gap:7}}><Text style={{fontSize:18,fontWeight:'600',color:c.foreground}}>Desktop peer agents</Text>{peers.map(peer => <Text selectable key={peer.agentId} style={{color:c.foreground}}>{peer.scope} · {peer.openid}\n主机 {peer.hostId} · 工作区 {peer.workspaceId} · agent {peer.agentId} · preset {peer.preset}</Text>)}{peers.length === 0 ? <Text style={{color:c.foregroundMuted}}>首条获准 QQ 消息将在 Desktop 创建可恢复的真实 agent。</Text> : null}</View>
    <View style={{gap:10}}><Text style={{fontSize:18,fontWeight:'600',color:c.foreground}}>显式导入 DSH QQ 设置</Text><Text style={{color:c.foregroundMuted}}>选择并粘贴旧 cordis.patch.yml、im-qqbot 配置或成员 JSON；也可提交 {'{config, members, preferences, desktopPresets}'} 组合文档。原文件与历史保持原样；无法转换的 Cordis 挂载逐项报告。凭据只通过专用 secret 操作提交。</Text><TextInput accessibilityLabel="DSH QQ 配置 YAML" multiline value={importDocument} onChangeText={setImportDocument} style={[inputStyle,{minHeight:120}]}/>{button(importSecret ? '凭据：一并导入' : '凭据：不导入',() => setImportSecret(v => !v))}{button('导入选择的 DSH 数据',() => run(async()=>{const prepared=prepareDshImport(importDocument);const credentialKey=importSecret&&prepared.secret?`credential-draft:${crypto.randomUUID()}`:undefined;try{if(credentialKey){if(!prepared.appId)throw new Error('所选凭据缺少 AppID');await ctx.secrets.set(credentialKey,prepared.secret!);}await ctx.rpc(action,{kind:'import',source:'dsh-qqbot',document:prepared.document,credentialKey,accessRevision:access.revision});setImportDocument('');}finally{if(credentialKey)await ctx.secrets.delete(credentialKey);}}))}{(snapshot?.importReport ?? state.importReport).map((line,i) => <Text key={i} style={{color:c.foregroundMuted}}>{line}</Text>)}</View>
  </ScrollView>;
}

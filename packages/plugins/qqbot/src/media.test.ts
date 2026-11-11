import { afterEach, expect, it, vi } from 'vitest';
import type { PluginNativeApi } from '@omp-desktop/plugin/server';
import { ConfigSchema, PeerSchema } from './state.ts';
import { SandboxFiles } from './sandbox-files.ts';
import { allowedFile, cleanMedia, downloadAttachment } from './media.ts';

afterEach(() => vi.unstubAllGlobals());
const root='/qq-private-root';
const peer=PeerSchema.parse({appId:'app',scope:'c2c',openid:'peer',hostId:'host',workspaceId:'workspace',agentId:'agent',cwd:root,sandbox:{root},preset:'default',template:{name:'default',config:{provider:'omp'}},protocolPrompt:'QQ',lastDeliveredSequence:0});
const config=ConfigSchema.parse({sendFile:{extraRoots:['/outside','/'],sendPresentedFiles:true},media:{maxMB:1}});
async function fixture() {
  const invoke=vi.fn(async (_operation:string,input:unknown):Promise<unknown> => {
    if(!input||typeof input!=='object'||!('action' in input))throw new Error('Missing action');
    if(input.action==='open')return{handle:'pinned'};
    if(input.action==='read')return{contentBase64:Buffer.from('inside-canary').toString('base64')};
    if(input.action==='list')return{entries:[]};
    return{ok:true};
  });
  const native={invoke} as unknown as PluginNativeApi;
  const files=await SandboxFiles.open(native,root,1024*1024);
  return{invoke,files};
}

it('outside media is rejected despite extraRoots and never reaches a native read',async()=>{
  const f=await fixture();
  for(const path of ['/outside/file.txt','/qq-private-root-escape/file.txt','../file.txt','folder/../file.txt','ssh://host/file','C:\\Windows\\file','\\\\host\\share','file\0.txt'])await expect(allowedFile(path,peer,config,f.files)).rejects.toThrow();
  expect(f.invoke.mock.calls.filter(([,input])=>input&&typeof input==='object'&&'action' in input&&input.action==='read')).toEqual([]);
});

it('trusted inside metadata maps to a relative pinned read and returns byte snapshots',async()=>{
  const f=await fixture();
  expect((await allowedFile(`${root}/image.png`,peer,config,f.files)).toString()).toBe('inside-canary');
  expect(f.invoke).toHaveBeenLastCalledWith('files.sandbox',{action:'read',handle:'pinned',path:'image.png',maxBytes:1024*1024});
  await expect(allowedFile('image.png',{...peer,sandbox:undefined},config,f.files)).rejects.toThrow('已确认');
});

it('downloads only bounded HTTPS QQ bytes with exclusive descriptor-bound writes',async()=>{
  const f=await fixture();
  const fetch=vi.fn(async()=>new Response(Buffer.from('qq-image'),{headers:{'content-length':'8'}}));vi.stubGlobal('fetch',fetch);
  const file=await downloadAttachment({filename:'photo.png',content_type:'image/png',size:8,url:'https://qpic.cn/image'},root,config,new AbortController().signal,f.files);
  expect(file.relativePath).toMatch(/^\.qqbot-media\/[0-9a-f-]+-photo\.png$/);
  expect(file.path).toBe(`${root}/${file.relativePath}`);
  expect(file.size).toBe(8);
  expect(f.invoke).toHaveBeenLastCalledWith('files.sandbox',{action:'write',handle:'pinned',path:file.relativePath,contentBase64:Buffer.from('qq-image').toString('base64'),maxBytes:1024*1024,exclusive:true});
  await expect(downloadAttachment({filename:'x',content_type:'text/plain',size:1,url:'https://outside.invalid/x'},root,config,new AbortController().signal,f.files)).rejects.toThrow('QQ HTTPS');
  expect(fetch).toHaveBeenCalledOnce();
});

it('accepts QQ multimedia downloads without trusting lookalike or unrelated hosts',async()=>{
  const f=await fixture();
  const bytes=Buffer.from('official-qq-image');
  const fetch=vi.fn(async()=>new Response(bytes));vi.stubGlobal('fetch',fetch);
  const attachment={filename:'photo.png',content_type:'image/png',size:0,url:'https://multimedia.nt.qq.com.cn/download?appid=local&fileid=canary&rkey=local-only&spec=0'};
  const file=await downloadAttachment(attachment,root,config,new AbortController().signal,f.files);
  expect(file.size).toBe(bytes.length);
  for(const url of ['http://multimedia.nt.qq.com.cn/download','https://multimedia.nt.qq.com.cn.attacker.invalid/download','https://other.qq.com.cn/download','https://multimedia.nt.qq.com.cn@attacker.invalid/download']){
    await expect(downloadAttachment({...attachment,url},root,config,new AbortController().signal,f.files)).rejects.toThrow('QQ HTTPS');
  }
  expect(fetch).toHaveBeenCalledOnce();
});

it('oversized media never starts a file write',async()=>{
  const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response(Buffer.alloc(1024*1024+1))));
  await expect(downloadAttachment({filename:'large',content_type:'application/octet-stream',size:0,url:'https://qpic.cn/large'},root,config,new AbortController().signal,f.files)).rejects.toThrow('下载上限');
  expect(f.invoke.mock.calls.some(([,input])=>input&&typeof input==='object'&&'action' in input&&input.action==='write')).toBe(false);
});

it('TTL deletion uses only native-listed sandbox entries and pinned remove',async()=>{
  const f=await fixture();const old='11111111-1111-4111-8111-111111111111-old.png';
  f.invoke.mockImplementation(async(_operation,input)=>{if(input&&typeof input==='object'&&'action' in input&&input.action==='list')return{entries:[{name:old,isDirectory:false,size:1,modifiedAt:0},{name:'user-file.txt',isDirectory:false,size:1,modifiedAt:0},{name:'22222222-2222-4222-8222-222222222222-new.png',isDirectory:false,size:1,modifiedAt:Date.now()}]};return{ok:true};});
  await cleanMedia(f.files,24);
  expect(f.invoke).toHaveBeenLastCalledWith('files.sandbox',{action:'remove',handle:'pinned',path:`.qqbot-media/${old}`});
});

it('closed bridge rejects reads before making another native call',async()=>{
  const f=await fixture();await f.files.close();const calls=f.invoke.mock.calls.length;
  await expect(f.files.read('inside.txt')).rejects.toThrow('已关闭');expect(f.invoke.mock.calls).toHaveLength(calls);
});

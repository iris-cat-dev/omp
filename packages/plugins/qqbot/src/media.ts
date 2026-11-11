import { createWriteStream } from 'node:fs';
import { mkdir, realpath, stat, lstat, readdir, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Peer, Config } from './state.ts';
export function within(root: string, path: string) { const p = relative(root, path); return p === '' || (!p.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && p !== '..' && !isAbsolute(p)); }
export async function allowedFile(path: string, peer: Peer, config: Config): Promise<string> {
  const actual = await realpath(resolve(peer.cwd, path));
  const roots = await Promise.all([peer.cwd, ...config.sendFile.extraRoots].map(root => realpath(root)));
  if (!roots.some(root => within(root, actual))) throw new Error('文件不在已授权的工作区或额外根目录内');
  const info = await stat(actual); if (!info.isFile() || info.size > config.media.maxMB * 1024 * 1024) throw new Error('文件类型或大小不符合当前投递约束'); return actual;
}
export interface RawAttachment { filename: string; content_type: string; size: number; url: string; asr_refer_text?: string }
export async function downloadAttachment(attachment: RawAttachment, cwd: string, config: Config, signal: AbortSignal): Promise<{ path: string; mimeType: string }> {
  if (!config.media.enabled) throw new Error('QQ 富媒体接收已关闭');
  const url = new URL(attachment.url.startsWith('//') ? `https:${attachment.url}` : attachment.url);
  if (url.protocol !== 'https:' || !['qq.com','qpic.cn','myqcloud.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw new Error('附件不是受支持的 QQ HTTPS 媒体地址');
  const max = config.media.maxMB * 1024 * 1024; if (attachment.size > max) throw new Error('附件超过下载上限');
  const requestedRoot=resolve(cwd,'.qqbot-media');await mkdir(requestedRoot,{recursive:true});
  if((await lstat(requestedRoot)).isSymbolicLink())throw new Error('QQ 媒体目录不能是符号链接');
  const root=await realpath(requestedRoot);if(!within(await realpath(cwd),root))throw new Error('QQ 媒体目录不在工作区内');
  const path=resolve(root,`${randomUUID()}-${basename(attachment.filename||'attachment')}`);
  if (!within(root, path)) throw new Error('非法附件文件名');
  const response = await fetch(url, { signal, redirect: 'error' });
  if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`QQ 附件下载失败 (${response.status})`);}
  if(Number(response.headers.get('content-length')??0)>max){await response.body.cancel();throw new Error('附件超过下载上限');}
  let bytes = 0; const limiter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > max ? new Error('附件超过下载上限') : null, chunk); } });
  try { await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal }); }
  catch (error) { await unlink(path).catch(() => undefined); throw error; }
  return { path, mimeType: attachment.content_type };
}
export async function cleanMedia(cwd:string,ttlHours:number){
  if(ttlHours===0)return;
  const requestedRoot=resolve(cwd,'.qqbot-media');
  const rootInfo=await lstat(requestedRoot).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(!rootInfo)return;
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('QQ 媒体目录必须是工作区内的普通目录');
  const root=await realpath(requestedRoot);if(!within(await realpath(cwd),root))throw new Error('QQ 媒体目录不在工作区内');
  for(const file of await readdir(root,{withFileTypes:true})){
    if(!file.isFile()||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/.test(file.name))continue;
    const path=resolve(root,file.name);if(Date.now()-(await stat(path)).mtimeMs>ttlHours*3600000)await unlink(path);
  }
}
export function mediaType(path: string): 'image' | 'video' | 'voice' | 'file' { const ext = extname(path).toLowerCase(); return ['.png','.jpg','.jpeg','.gif','.webp'].includes(ext) ? 'image' : ['.mp4','.mov','.webm'].includes(ext) ? 'video' : ['.mp3','.wav','.silk','.ogg'].includes(ext) ? 'voice' : 'file'; }

import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SandboxFiles, sandboxRelativePath } from './sandbox-files.ts';
import type { Peer, Config } from './state.ts';
export function within(root: string, path: string) { const p = relative(root, path); return p === '' || (!p.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && p !== '..' && !isAbsolute(p)); }
export async function allowedFile(path: string, peer: Peer, config: Config, files: SandboxFiles): Promise<Buffer> {
  if (!peer.sandbox || peer.sandbox.root !== peer.cwd) throw new Error('QQ 文件投递需要已确认的沙箱');
  if(path.includes('\0')||path.includes('\\')||path.split('/').includes('..'))throw new Error('文件路径不在 QQ 沙箱命名空间内');
  // Absolute paths are accepted only from trusted Desktop presented-file metadata.
  // Reduce them to a relative namespace before the native descriptor-bound read.
  if (isAbsolute(path)) {
    if (!within(peer.sandbox.root, path)) throw new Error('文件不在 QQ 沙箱内');
    path = relative(peer.sandbox.root, path);
  }
  return files.read(sandboxRelativePath(path), config.media.maxMB * 1024 * 1024);
}

export function validateGeneratedImage(bytes: Buffer, mimeType: string) {
  const valid = mimeType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mimeType === 'image/gif' ? bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))
    : mimeType === 'image/webp' ? bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP'
    : false;
  if (!valid) throw new Error('生成图片内容与 MIME 不匹配');
}
export interface RawAttachment { filename: string; content_type: string; size: number; url: string; asr_refer_text?: string }
export async function downloadAttachment(attachment: RawAttachment, cwd: string, config: Config, signal: AbortSignal, files: SandboxFiles): Promise<{ path: string; relativePath: string; mimeType: string; size: number }> {
  if (!config.media.enabled) throw new Error('QQ 富媒体接收已关闭');
  const url = new URL(attachment.url.startsWith('//') ? `https:${attachment.url}` : attachment.url);
  if (url.protocol !== 'https:' || (url.hostname !== 'multimedia.nt.qq.com.cn' && !['qq.com','qpic.cn','myqcloud.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)))) throw new Error('附件不是受支持的 QQ HTTPS 媒体地址');
  const max = config.media.maxMB * 1024 * 1024; if (attachment.size > max) throw new Error('附件超过下载上限');
  await files.mkdir('.qqbot-media');
  const name=basename((attachment.filename||'attachment').replaceAll('\\','/')).replaceAll('\0','_').slice(0,64);
  const relativePath=`.qqbot-media/${randomUUID()}-${name}`;
  const response = await fetch(url, { signal, redirect: 'error' });
  if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`QQ 附件下载失败 (${response.status})`);}
  if(Number(response.headers.get('content-length')??0)>max){await response.body.cancel();throw new Error('附件超过下载上限');}
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try {
    for (;;) { const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>max){await reader.cancel();throw new Error('附件超过下载上限');}chunks.push(result.value); }
  } finally { reader.releaseLock(); }
  signal.throwIfAborted();
  await files.write(relativePath,Buffer.concat(chunks,size));
  return { path:resolve(cwd,relativePath),relativePath,mimeType:attachment.content_type,size };
}
export async function cleanMedia(files:SandboxFiles,ttlHours:number){
  if(ttlHours===0)return;
  await files.mkdir('.qqbot-media');
  for(const file of await files.list('.qqbot-media')){
    if(file.isDirectory&&file.name==='generated'){
      for(const generated of await files.list('.qqbot-media/generated')){
        if(generated.isDirectory||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/.test(generated.name))continue;
        if(Date.now()-generated.modifiedAt>ttlHours*3600000)await files.remove(`.qqbot-media/generated/${generated.name}`);
      }
      continue;
    }
    if(file.isDirectory||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/.test(file.name))continue;
    if(Date.now()-file.modifiedAt>ttlHours*3600000)await files.remove(`.qqbot-media/${file.name}`);
  }
}
export function mediaType(path: string): 'image' | 'video' | 'voice' | 'file' { const ext = extname(path).toLowerCase(); return ['.png','.jpg','.jpeg','.gif','.webp'].includes(ext) ? 'image' : ['.mp4','.mov','.webm'].includes(ext) ? 'video' : ['.mp3','.wav','.silk','.ogg'].includes(ext) ? 'voice' : 'file'; }

import { z } from 'zod';
import type { PluginNativeApi } from '@omp-desktop/plugin/server';

const OpenResult = z.object({ handle: z.string().min(1) });
const ReadResult = z.object({ contentBase64: z.string() });
const ListResult = z.object({ entries: z.array(z.object({ name: z.string(), isDirectory: z.boolean(), size: z.number().nonnegative(), modifiedAt: z.number() })) });
const OkResult = z.object({ ok: z.literal(true) });

export function sandboxRelativePath(path: string) {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path) || path.split('/').some(part => part === '..' || !part)) throw new Error('文件路径不在 QQ 沙箱命名空间内');
  return path;
}

export class SandboxFiles {
  private closed = false;
  private constructor(private native: PluginNativeApi, private handle: string, private maxBytes: number) {}
  static async open(native: PluginNativeApi, root: string, maxBytes: number) {
    const { handle } = OpenResult.parse(await native.invoke('files.sandbox', { action: 'open', root, maxBytes }));
    return new SandboxFiles(native, handle, maxBytes);
  }
  private async invoke(action: string, path?: string, fields: Record<string, unknown> = {}) {
    if (this.closed) throw new Error('QQ 沙箱文件句柄已关闭');
    return this.native.invoke('files.sandbox', { action, handle: this.handle, ...(path === undefined ? {} : { path: sandboxRelativePath(path) }), ...fields });
  }
  async read(path: string, maxBytes = this.maxBytes) {
    const result = ReadResult.parse(await this.invoke('read', path, { maxBytes }));
    return Buffer.from(result.contentBase64, 'base64');
  }
  async write(path: string, bytes: Buffer) {
    if (bytes.length > this.maxBytes) throw new Error('QQ 文件超过沙箱媒体上限');
    OkResult.parse(await this.invoke('write', path, { contentBase64: bytes.toString('base64'), maxBytes: this.maxBytes, exclusive: true }));
  }
  async mkdir(path: string) { OkResult.parse(await this.invoke('mkdir', path)); }
  async list(path: string) { return ListResult.parse(await this.invoke('list', path)).entries; }
  async remove(path: string) { OkResult.parse(await this.invoke('remove', path)); }
  async close() {
    if (this.closed) return;
    this.closed = true;
    OkResult.parse(await this.native.invoke('files.sandbox', { action: 'close', handle: this.handle }));
  }
}

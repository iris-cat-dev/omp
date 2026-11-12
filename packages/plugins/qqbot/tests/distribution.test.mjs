import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Use Node's built SDK entrypoints, not Vitest's source-module transform.
// Run after building the plugin SDK and QQ package.
const require = createRequire(import.meta.url);
const { compilePackageEntries } = require('@omp-desktop/plugin/compiler');
const { IsolatedPluginWorker } = require('@omp-desktop/plugin/worker');

it.each(['cjs', 'mjs'])('executes built QQ %s management RPCs in an isolated worker', async extension => {
  const serviceEntry = fileURLToPath(new URL(`../dist/service.${extension}`, import.meta.url));
  const { serverBundle } = await compilePackageEntries({ serviceEntry });
  const generation = 7;
  const installation = {
    id: 'qq-distribution', packageId: '@omp-desktop/plugin-qqbot', owner: 'desktop',
    version: '1.0.0', generation, enabled: false,
    declaredCapabilities: ['storage.scoped'], grantedCapabilities: ['storage.scoped'],
  };
  let values = {}, revision = 0;
  const worker = await IsolatedPluginWorker.start({
    installation, serviceEntry, serverBundle, format: 'package', mode: 'manage',
    hostCall(operation, input) {
      if (operation === 'storage.get') return { values: structuredClone(values), revision };
      if (operation === 'storage.patch') {
        if (input.expectedRevision !== revision) throw new Error('REVISION_CONFLICT');
        values = { ...values, ...input.patch };
        return { values: structuredClone(values), revision: ++revision };
      }
      throw new Error(`Management must not acquire credentials or a gateway: ${operation}`);
    },
  });
  try {
    const status = await worker.invoke('qqbot.status', {}, generation);
    expect(status).toMatchObject({ generation, connection: 'waiting', secretConfigured: false, binding: { phase: 'idle' } });
    const edited = await worker.invoke('qqbot.action', { kind: 'manual', purpose: 'owner', text: 'owner:Artifact', accessRevision: 0 }, generation);
    expect(edited.access.revision).toBe(1);
    expect(edited.access.owners).toEqual([expect.objectContaining({ openid: 'owner', nickname: 'Artifact' })]);
    expect(await worker.invoke('qqbot.export-access', { purpose: 'owner', accessRevision: 1 }, generation)).toEqual({ appId: '', revision: 1, text: 'owner:Artifact' });
    await expect(worker.invoke('qqbot.export-access', { purpose: 'owner', accessRevision: 0 }, generation)).rejects.toThrow('ACCESS_REVISION_CONFLICT');
  } finally {
    await worker.stop();
  }
}, 10000);

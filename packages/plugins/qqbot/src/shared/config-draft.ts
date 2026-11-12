import { ConfigSchema, type Config } from '../state.ts';

export function parseConfigDraft(text: string): Config | null {
  try { return ConfigSchema.parse(JSON.parse(text)); } catch { return null; }
}

export function editSandboxPath(text: string, sandboxPath: string): string {
  const config = ConfigSchema.parse(JSON.parse(text));
  return JSON.stringify({ ...config, sandboxPath }, null, 2);
}

export function editSandboxCapability(text: string, capability: keyof Config['sandboxCapabilities'], enabled: boolean): string {
  const config = ConfigSchema.parse(JSON.parse(text));
  return JSON.stringify({ ...config, sandboxCapabilities: { ...config.sandboxCapabilities, [capability]: enabled } }, null, 2);
}

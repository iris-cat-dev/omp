import { expect, it } from 'vitest';
import { ConfigSchema } from '../state.ts';
import { editSandboxCapability, editSandboxPath, parseConfigDraft } from './config-draft.ts';

it('edits the one JSON draft without changing account, prompt or model config', () => {
  const before = ConfigSchema.parse({ appId: 'saved-app', cwd: '/legacy-root', presets: [{ name: 'default', config: { provider: 'omp/provider/model', thinkingOptionId: 'high', systemPrompt: 'Keep this' } }] });
  const text = editSandboxPath(JSON.stringify(before), '/new-root');
  expect(parseConfigDraft(text)).toEqual({ ...before, sandboxPath: '/new-root' });
  expect(JSON.parse(text)).not.toHaveProperty('cwd');
  expect(parseConfigDraft(editSandboxPath(text, ''))?.sandboxPath).toBe('');
});

it('does not replace an invalid JSON draft with a default config', () => {
  expect(parseConfigDraft('{broken')).toBeNull();
  expect(() => editSandboxPath('{broken', '/new-root')).toThrow();
  expect(parseConfigDraft('{"presets":[{"name":"default","config":{"provider":"omp","mcpServers":{}}}]}')).toBeNull();
});

it('keeps image generation opt-in and synchronizes capability controls with JSON', () => {
  const before = ConfigSchema.parse({ appId: 'saved-app', sandboxCapabilities: { javascript: true, network: false }, presets: [{ name: 'default', config: { provider: 'omp/provider/model', systemPrompt: 'Keep this' } }] });
  expect(before.sandboxCapabilities.imageGeneration).toBe(false);
  const enabled = editSandboxCapability(JSON.stringify(before), 'imageGeneration', true);
  expect(parseConfigDraft(enabled)).toEqual({ ...before, sandboxCapabilities: { ...before.sandboxCapabilities, imageGeneration: true } });
  const manual = JSON.stringify({ ...JSON.parse(enabled), sandboxCapabilities: { javascript: false, network: true, imageGeneration: false } });
  expect(parseConfigDraft(manual)?.sandboxCapabilities).toEqual({ javascript: false, network: true, imageGeneration: false });
  expect(parseConfigDraft(editSandboxCapability(enabled, 'imageGeneration', false))).toEqual(before);
  expect(() => editSandboxCapability('{broken', 'imageGeneration', true)).toThrow();
  expect(parseConfigDraft('{broken')).toBeNull();
});

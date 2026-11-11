import { expect, it } from 'vitest';
import { redactQqMessage } from './privacy.ts';
it('redacts active QQ credentials and tokens from logs, context and receipts', () => {
  const text = 'failure platform-token; secret-line\nnext; Authorization: QQBot platform-token';
  const clean = redactQqMessage(text, ['platform-token', 'secret-line\nnext']);
  expect(clean).not.toContain('platform-token');
  expect(clean).not.toContain('secret-line');
  expect(clean).toContain('[redacted]');
});
it('handles JSON escaped values and token bodies before the first API request', () => {
  const clean = redactQqMessage(JSON.stringify({ value: 'private\n"line', access_token: 'fresh-platform-value', appSecret: 'private-account-value' }), ['private\n"line']);
  expect(clean).not.toContain('fresh-platform-value');
  expect(clean).not.toContain('private-account-value');
  expect(clean).not.toContain('line');
});
it('preserves ordinary text and treats empty configured values as absent', () => {
  expect(redactQqMessage('normal answer', ['', 'unrelated'])).toBe('normal answer');
});

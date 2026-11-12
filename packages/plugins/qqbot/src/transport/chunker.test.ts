import { expect, it } from 'vitest';
import { chunkMarkdownText } from './chunker.ts';
it('keeps short messages unchanged and enforces limits for oversized code/text/table lines',()=>{expect(chunkMarkdownText('short',200)).toEqual(['short']);for(const text of ['x'.repeat(12000),`\`\`\`text\n${'x'.repeat(12000)}\n\`\`\``,`| ${'cell'.repeat(3000)} |`]){const chunks=chunkMarkdownText(text,4500);expect(chunks.length).toBeGreaterThan(1);expect(chunks.every(c=>c.length<=4500)).toBe(true);}});
it('never splits Unicode surrogate pairs in a forced chunk',()=>{const text='🙂'.repeat(401);const chunks=chunkMarkdownText(text,201);expect(chunks.join('')).toBe(text);expect(chunks.every(c=>!/[\uD800-\uDBFF]$/.test(c)&&!(c.charCodeAt(0)>=0xDC00&&c.charCodeAt(0)<=0xDFFF))).toBe(true);});

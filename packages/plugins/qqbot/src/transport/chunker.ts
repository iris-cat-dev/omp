/**
 * Markdown 文本切分器
 *
 * QQ 单条消息有字符数限制（约 5000），需要在合适边界切分，
 * 优先保持 GFM 表格行与代码行；超过平台限制时强制分块。
 */

const CODE_FENCE_OPEN = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;

/**
 * 按换行边界切分 Markdown 文本
 * - 表格优先作为整体追加；其他内容按行追加
 * - 过长的表格或单行按 QQ 上限切分，不切断 Unicode 代理对
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let inCodeBlock = false;
  let tableBuffer: string[] = [];

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return;
    const block = tableBuffer.join('\n');
    tableBuffer = [];

    if (!current) {
      current = block;
      return;
    }

    const candidate = `${current}\n${block}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  };

  const appendLine = (line: string): void => {
    if (!current) {
      current = line;
      return;
    }
    const candidate = `${current}\n${line}`;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  };

  for (const line of lines) {
    if (CODE_FENCE_OPEN.test(line)) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      appendLine(line);
      continue;
    }

    if (inCodeBlock) {
      appendLine(line);
      continue;
    }

    if (GFM_TABLE_LINE.test(line)) {
      tableBuffer.push(line);
      continue;
    }

    flushTable();
    appendLine(line);
  }

  flushTable();
  if (current) chunks.push(current);

  if (chunks.every(chunk => chunk.length <= limit)) return chunks;
  // An oversized table row or unbroken code/text line must still respect QQ's
  // hard limit. Never split a UTF-16 surrogate pair at the boundary.
  return chunks.flatMap(chunk => {
    if (chunk.length <= limit) return [chunk];
    const bounded: string[] = [];
    for (let offset = 0; offset < chunk.length;) {
      let end = Math.min(offset + limit, chunk.length);
      if (end < chunk.length && /[\uD800-\uDBFF]/.test(chunk[end - 1]!) && /[\uDC00-\uDFFF]/.test(chunk[end]!)) end--;
      bounded.push(chunk.slice(offset, end));
      offset = end;
    }
    return bounded;
  });
}

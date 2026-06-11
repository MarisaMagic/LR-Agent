/** 展示分析脚本 stdout：还原 \\u 转义，格式化 JSON 行。 */
export function formatAnalysisStdout(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  let text = decodeUnicodeEscapes(trimmed);

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // 非完整 JSON，保留解码后的文本
    }
  }

  return text;
}

function decodeUnicodeEscapes(text: string): string {
  if (!/\\u[0-9a-fA-F]{4}/.test(text)) {
    return text;
  }
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

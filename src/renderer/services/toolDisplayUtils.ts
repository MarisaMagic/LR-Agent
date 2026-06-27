/** 工具参数在聊天 UI 中的展示摘要（避免把整文件内容塞进 tool_call 块）。 */

const WRITE_WORKSPACE_FILE = 'write_workspace_file';

export function summarizeToolArgumentsForDisplay(
  name: string,
  argsJson: string,
): string {
  if (name !== WRITE_WORKSPACE_FILE) {
    return argsJson;
  }

  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const relativePath = String(
      args.relative_path ?? args.relativePath ?? '',
    );
    const content = typeof args.content === 'string' ? args.content : '';
    const lineCount = content ? content.split('\n').length : 0;
    return JSON.stringify(
      {
        relative_path: relativePath,
        content: `[${content.length} 字符, ${lineCount} 行]`,
      },
      null,
      2,
    );
  } catch {
    if (argsJson.length <= 400) {
      return argsJson;
    }
    return `${argsJson.slice(0, 400)}…`;
  }
}

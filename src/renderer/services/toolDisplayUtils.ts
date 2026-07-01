/** 工具参数在聊天 UI 中的展示摘要（避免把整文件内容塞进 tool_call 块）。 */

const WRITE_WORKSPACE_FILE = 'write_workspace_file';
const READ_WORKSPACE_FILE = 'read_workspace_file';
const GREP_WORKSPACE = 'grep_workspace';
const LIST_WORKSPACE_DIRECTORY = 'list_workspace_directory';

export const EXPLORATION_TOOL_NAMES = new Set([
  READ_WORKSPACE_FILE,
  GREP_WORKSPACE,
  LIST_WORKSPACE_DIRECTORY,
]);

export function isExplorationTool(name: string): boolean {
  return EXPLORATION_TOOL_NAMES.has(name);
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pathFromArgs(args: Record<string, unknown>): string {
  return String(
    args.relative_path ??
      args.relativePath ??
      args.path ??
      args.relative_dir ??
      args.relativeDir ??
      '',
  ).trim();
}

export function formatToolCallLabel(name: string, argsJson: string): string {
  const args = parseArgs(argsJson);

  if (name === READ_WORKSPACE_FILE) {
    const p = pathFromArgs(args) || '当前文件';
    const start = args.start_line ?? args.startLine;
    const end = args.end_line ?? args.endLine;
    if (start != null || end != null) {
      const s = start ?? 1;
      const e = end ?? start ?? 1;
      return `Read ${p} L${s}-${e}`;
    }
    return `Read ${p}`;
  }

  if (name === GREP_WORKSPACE) {
    const pattern = String(args.pattern ?? '').trim() || '?';
    const scope = pathFromArgs(args) || 'workspace';
    return `Grepped ${pattern} in ${scope}`;
  }

  if (name === LIST_WORKSPACE_DIRECTORY) {
    const dir = pathFromArgs(args) || '.';
    return `Listed ${dir}`;
  }

  return name;
}

export function summarizeToolArgumentsForDisplay(
  name: string,
  argsJson: string,
): string {
  if (name === WRITE_WORKSPACE_FILE) {
    try {
      const args = parseArgs(argsJson);
      const relativePath = pathFromArgs(args);
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

  if (name === READ_WORKSPACE_FILE || name === GREP_WORKSPACE) {
    const args = parseArgs(argsJson);
    return JSON.stringify(args, null, 2);
  }

  if (name === LIST_WORKSPACE_DIRECTORY) {
    const args = parseArgs(argsJson);
    return JSON.stringify(args, null, 2);
  }

  return argsJson;
}

const MAX_TOOL_RESULT_CHARS = 1200;

export function summarizeToolResultForDisplay(
  name: string,
  result: string,
): string {
  if (!result) {
    return result;
  }

  if (
    name === GREP_WORKSPACE ||
    name === READ_WORKSPACE_FILE ||
    name === LIST_WORKSPACE_DIRECTORY
  ) {
    if (result.length <= MAX_TOOL_RESULT_CHARS) {
      return result;
    }
    const lineCount = result.split('\n').length;
    return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}…\n[共 ${lineCount} 行, ${result.length} 字符]`;
  }

  return result;
}

export function buildExplorationSummary(
  tools: { name: string }[],
): string {
  let reads = 0;
  let greps = 0;
  let lists = 0;

  for (const tool of tools) {
    if (tool.name === READ_WORKSPACE_FILE) reads += 1;
    else if (tool.name === GREP_WORKSPACE) greps += 1;
    else if (tool.name === LIST_WORKSPACE_DIRECTORY) lists += 1;
  }

  const parts: string[] = [];
  if (reads > 0) {
    parts.push(`${reads} file${reads === 1 ? '' : 's'}`);
  }
  if (greps > 0) {
    parts.push(`${greps} search${greps === 1 ? '' : 'es'}`);
  }
  if (lists > 0) {
    parts.push(`${lists} listing${lists === 1 ? '' : 's'}`);
  }

  if (parts.length === 0) {
    return 'Explored workspace';
  }
  return `Explored ${parts.join(', ')}`;
}

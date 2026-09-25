/**
 * 大工具结果的预览化（上下文治理第 1 层：大结果不整段进上下文）。
 *
 * 对于**可重取**的只读工具（read / grep / glob / list / document），结果过大时
 * 只保留前若干字符 + 重取提示——模型需要时可换更窄的参数再次获取。
 *
 * 与 Claude Code「大结果落盘」的差异：本项目只读工具本身支持 `offset/limit`
 * 与 pattern 收窄，重取成本低，因此无需落盘 + 专用读回工具，直接折叠更简单。
 * 完整内容也不会丢失——它仍可从磁盘/标注库重新读出。
 *
 * 仅对纯文本输出的可重取工具生效；JSON 结构化结果（如 read_file_annotation）
 * 不在此列，避免截断破坏结构。
 */

import type { AgentSettings } from '../config';

/** 可重取、纯文本输出的只读工具。 */
export const RE_RETRIEVABLE_TOOLS: ReadonlySet<string> = new Set([
  'read_workspace_file',
  'read_document_file',
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
]);

/** 重取提示（按工具特点给出更具体的做法）。 */
function reRetrieveHint(toolName: string, originalLength: number): string {
  const byTool: Record<string, string> = {
    read_workspace_file: '用 offset / limit 分段读取，或只看需要的那一段',
    read_document_file: '减少 max_pages，或指定页码范围',
    grep_workspace: '收紧 pattern，或降低 max_results',
    glob_workspace: '收窄 glob_pattern',
    list_workspace_directory: '进入具体子目录后再列',
  };
  const hint = byTool[toolName] ?? '缩小范围后重新获取';
  return (
    `\n\n[结果过大已截断：原始约 ${originalLength} 字符。` +
    `如需完整内容，请${hint}。]`
  );
}

/**
 * 必要时把结果折叠为预览；不需要时原样返回。
 *
 * @param toolName 工具名（决定是否可折叠）
 * @param result   已格式化的结果文本
 */
export function maybePreviewLargeResult(params: {
  toolName: string;
  result: string;
  settings: AgentSettings;
}): string {
  const { toolName, result, settings } = params;
  if (settings.toolResultPreviewBytes <= 0) return result;
  if (!RE_RETRIEVABLE_TOOLS.has(toolName)) return result;
  if (result.length <= settings.toolResultPreviewBytes) return result;

  // 预览长度不得超过阈值，否则「截断后反而整段返回」并附加误导性提示
  const previewChars = Math.min(
    Math.max(0, settings.toolResultPreviewChars),
    settings.toolResultPreviewBytes,
  );
  return (
    result.slice(0, previewChars) + reRetrieveHint(toolName, result.length)
  );
}

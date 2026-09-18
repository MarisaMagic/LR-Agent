/**
 * Assist 模式路由器：基于客户端上下文决定工具集。
 *
 * 移植自 `vendor/local-agent/app/agent/assist_mode_router.py`。
 *
 * 注意 `get_account_summary` 与 `describe_client_context` **不在**主 Agent 工具集里：
 * 前者在本地应用无用，后者要的信息 system prompt 已注入，二者的 schema 只会白占
 * prompt 前缀并诱发无关调用。但两者仍在 registry 注册，供子代理内部使用。
 */

/** 编辑器 / 纯工作区：只读 + 工作区写文件（无标注工具）。 */
export const LIGHT_TOOL_SET: ReadonlySet<string> = new Set([
  'read_workspace_file',
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
  'read_document_file',
  'read_image_for_vision',
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'move_workspace_file',
  'get_lr_agent_help',
  'describe_annotation_project',
  'read_file_annotation',
  'explore_readonly',
]);

/** 标注项目 Agent：完整工具集。 */
export const FULL_TOOL_SET: ReadonlySet<string> = new Set([
  'read_workspace_file',
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
  'read_document_file',
  'read_image_for_vision',
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'move_workspace_file',
  'auto_annotate',
  'mutate_annotation',
  'get_lr_agent_help',
  'describe_annotation_project',
  'read_file_annotation',
  'explore_readonly',
]);

/** 写入类工具（Ask 模式一律剔除）。 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'auto_annotate',
  'mutate_annotation',
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'move_workspace_file',
]);

/** Ask 模式：有项目快照也只读。 */
export const ASK_TOOL_SET: ReadonlySet<string> = new Set(
  [...FULL_TOOL_SET].filter((name) => !WRITE_TOOL_NAMES.has(name)),
);

/**
 * 选择工具集。
 *
 * Ask / 缺失模式一律只读；Agent 仅在标注任务（有快照且非编辑器）给完整工具。
 */
export function resolveAssistToolSet(params: {
  hasProjectSnapshot: boolean;
  agentMode: string | null | undefined;
  isEditor: boolean;
  hasWorkspace: boolean;
}): ReadonlySet<string> {
  const hasContext =
    params.hasProjectSnapshot || params.isEditor || params.hasWorkspace;
  if (params.agentMode !== 'annotation') {
    return hasContext ? ASK_TOOL_SET : new Set<string>();
  }
  if (params.hasProjectSnapshot && !params.isEditor) return FULL_TOOL_SET;
  if (params.isEditor || params.hasWorkspace) return LIGHT_TOOL_SET;
  return new Set<string>();
}

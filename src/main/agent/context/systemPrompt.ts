/**
 * System prompt 组装（阶段 2 版本）与消息构建。
 *
 * **分块顺序固定，不可调整**（见协议文档 §9.1）：
 *   身份 → task → editor_note → 项目指令 → skills → 记忆 → 台账 → 阶段块
 *
 * 稳定块在前、动态块沉底，使 system prompt 的长前缀跨轮保持一致，以命中
 * DeepSeek / OpenAI 等服务端的前缀缓存。顺序变化会直接造成缓存失效。
 *
 * 阶段 2 已实现：身份块、task 段（工作区/项目两种）、编辑器纪律、项目指令、
 * skills catalog、工作区记忆、提案台账、阶段块。
 * 阶段 5 补齐：多模态附图与视觉兜底（不影响本模块）。
 */

import {
  ANNOTATION_CALL_GUIDE,
  ASSISTANT_TASK_BASE,
  FILE_EDIT_GUIDE,
  formatRuntimeIdentityBlock,
  formatSnapshotForPrompt,
  VISION_HINT,
  WORKSPACE_ASSIST_TASK,
} from './snapshot';
import { phasePromptBlock, type TaskPhaseContext } from '../loop/taskPhase';
import type { ParsedClientContext } from '../schemas';
import type { ChatMessage } from '../llm/client';
import { CHAT_SYSTEM_PROMPT } from './contextService';

/** 工作区助手任务段（含文件编辑纪律与工作区路径）。 */
function buildWorkspaceAssistantSystemPrompt(
  clientContext: ParsedClientContext,
): string {
  const parts = [
    WORKSPACE_ASSIST_TASK.replace('{vision_hint}', VISION_HINT),
    FILE_EDIT_GUIDE,
  ];
  const workspaceRoot = (clientContext.workspaceRoot ?? '').trim();
  if (workspaceRoot) parts.push(`【工作区】\n${workspaceRoot}`);
  return parts.join('\n\n');
}

/** 标注项目助手任务段。 */
function buildProjectAssistantSystemPrompt(
  clientContext: ParsedClientContext,
): string {
  const task = ASSISTANT_TASK_BASE.replace('{vision_hint}', VISION_HINT);
  const snapshot = clientContext.annotationProjectSnapshot;
  if (!snapshot) return task;
  return `${task}\n\n【当前标注项目快照】\n${formatSnapshotForPrompt(snapshot)}`;
}

/** 可用 Skills 目录块（稳定块，排在记忆与台账之前以命中前缀缓存）。 */
function formatSkillsCatalogBlock(
  skills: Array<{ name: string; description: string }>,
): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return (
    '【可用 Skills】\n' +
    `${lines.join('\n')}\n` +
    '匹配到某个 Skill 时，先调用 read_agent_skill 读取其 SKILL.md 正文，' +
    '再用 list_agent_skill_files / read_agent_skill 读取需要的附属文件；不要凭名字猜测内容。'
  );
}

/**
 * 组装 Assist 模式 system prompt。
 *
 * `clientContext` 为 null 时退化为身份块 + 纯对话提示词。
 */
export function buildAssistSystemPrompt(params: {
  clientContext: ParsedClientContext | null;
  model: string;
  supportsVision: boolean;
  taskPhaseContext: TaskPhaseContext | null;
}): string {
  const { clientContext } = params;
  const identity = formatRuntimeIdentityBlock({
    model: params.model,
    // 本地路径固定为 "local"（与 Python 侧一致）
    providerLabel: 'local',
    supportsVision: params.supportsVision,
  });

  if (!clientContext) {
    return `${identity}\n\n${CHAT_SYSTEM_PROMPT}`;
  }

  let task: string;
  if (clientContext.workMode === 'editor') {
    task = buildWorkspaceAssistantSystemPrompt(clientContext);
  } else if (clientContext.annotationProjectSnapshot) {
    task = buildProjectAssistantSystemPrompt(clientContext);
    // 标注 Agent 才有 auto_annotate；编辑器模式已被 registry 剥掉标注工具
    if (clientContext.agentMode === 'annotation') {
      task = `${task}\n\n${ANNOTATION_CALL_GUIDE}`;
    }
  } else if ((clientContext.workspaceRoot ?? '').trim()) {
    task = buildWorkspaceAssistantSystemPrompt(clientContext);
  } else {
    task = WORKSPACE_ASSIST_TASK.replace('{vision_hint}', VISION_HINT);
  }

  // 编辑器模式纪律
  let editorNote = '';
  if (clientContext.workMode === 'editor') {
    editorNote =
      clientContext.agentMode === 'annotation'
        ? '\n【编辑器模式】当前为编辑器 Agent：禁止调用标注读写、批量标注、标注变更相关工具；' +
          '可使用 read_workspace_file、write_workspace_file、' +
          'str_replace_workspace_file、move_workspace_file、read_document_file 等通用工具。'
        : '\n【编辑器模式】当前为编辑器 Ask：只读问答与分析。' +
          '禁止调用写文件、标注读写、批量标注与标注变更相关工具。';
  }

  let base = `${identity}\n\n${task}`;
  if (editorNote) base = `${base}${editorNote}`;

  const instructions = (clientContext.projectInstructions ?? '').trim();
  if (instructions) base = `${base}\n\n【项目指令】\n${instructions}`;

  // 稳定块（skills）先于动态块（记忆、台账）
  const skillsBlock = formatSkillsCatalogBlock(clientContext.skillsCatalog ?? []);
  if (skillsBlock) base = `${base}\n\n${skillsBlock}`;

  if (clientContext.workspaceMemoryEnabled) {
    const memoryIndex = (clientContext.memoryIndex ?? '').trim();
    const indexBlock = memoryIndex
      ? memoryIndex
      : '（尚无工作区记忆文件。进度与已标文件将在用户确认或保存标注后由系统生成。）';
    base =
      `${base}\n\n【工作区记忆】\n${indexBlock}\n` +
      '这是本标注任务的工作区记忆，可有多个 Markdown 文件。' +
      'progress.md 与 annotated-files.md 由系统在用户确认或标注落盘后更新；' +
      '需要细节时用 memory_read，不要凭印象改计数。' +
      'memory_create / memory_write 只用于用户规范、标注偏好与纠正' +
      '（如 conventions.md、preferences.md）；不要把未确认提案写成已完成。' +
      '项目指令优先级高于记忆。';
  }

  const ledger = (clientContext.proposalLedger ?? '').trim();
  if (ledger) base = `${base}\n\n${ledger}`;

  // 阶段块追加在末尾
  const phaseBlock = phasePromptBlock(params.taskPhaseContext);
  if (phaseBlock) base = `${base}\n\n${phaseBlock}`;

  return base;
}

/** 纯对话（无工具）分支的 system prompt。 */
export function buildChatSystemPrompt(systemPrompt: string | null): string {
  return systemPrompt || CHAT_SYSTEM_PROMPT;
}

/**
 * 构建发给 LLM 的消息数组。
 *
 * 顺序固定：主 SystemMessage → 可选摘要 SystemMessage → 历史消息。
 * 摘要作为**独立的第二条** SystemMessage 注入。
 */
export function buildChatMessages(params: {
  systemPrompt: string;
  contextSummary: string | null;
  messages: ChatMessage[];
}): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: params.systemPrompt }];
  if (params.contextSummary) {
    out.push({
      role: 'system',
      content: `【此前对话摘要】\n${params.contextSummary}`,
    });
  }
  out.push(...params.messages);
  return out;
}

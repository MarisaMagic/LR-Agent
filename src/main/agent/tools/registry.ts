/**
 * 内置工具注册表。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/registry.py`。
 *
 * 设计要点：
 *
 *   1. **zod 既是校验器也是 schema 来源**。`z.toJSONSchema` 生成的 JSON Schema
 *      会剥掉 `title`（Pydantic 的 `_strip_titles` 同样这么做，每字段省约 30 字符
 *      的工具前缀开销）。
 *
 *   2. **描述文本是行为契约**。工具描述与系统提示共同决定模型行为，必须与 Python
 *      侧逐字一致；「何时填某个参数」的纪律放在系统提示的标注调用纪律块里，
 *      不在每个工具描述中重复。
 *
 *   3. **执行器类型（kind）是三方共享的单一真源**。`sync` 在运行时内执行；
 *      `proposal` 由运行时生成提案事件、Electron **直接落盘**（免确认，可撤销）；
 *      `async` 暂停循环、由 Electron 执行后 resume（见协议文档 §5.1）。
 */

import { z } from 'zod';
import type { ToolSpec } from '../llm/client';
import { buildToolResult } from './result';
import {
  deleteWorkspaceFileTool,
  moveWorkspaceFileTool,
  strReplaceWorkspaceFileTool,
  writeWorkspaceFileTool,
  type PendingProposalContents,
} from './fileProposal';
import {
  globWorkspace,
  grepWorkspace,
  listWorkspaceDirectory,
} from './fileSearch';
import { readWorkspaceTextFile } from './fileReader';
import { readFileAnnotationTool } from './annotationDoc';
import { readDocumentFile } from './documentReader';
import { readImageForVisionTool } from './vision';
import type { ImageService } from '../services/imageService';
import {
  formatRuntimeIdentityBlock,
  formatSnapshotForPrompt,
} from '../context/snapshot';
import { type ClientContextLike } from './workspacePath';
import type { AgentSettings } from '../config';
/** 工具执行器类型。 */
export type ToolKind = 'sync' | 'proposal' | 'async';

/** 工具执行上下文。 */
export interface ToolContext {
  clientContext: ClientContextLike | null;
  settings: AgentSettings;
  /** provider 是否通过视觉探针（read_image_for_vision 用）。 */
  providerIsVision: boolean;
  /** 当前轮的用户文本（部分工具需要）。 */
  userContent: string;
  /**
   * 请求级提案内容缓存（路径 → (磁盘快照 | null, 提案内容)）。
   *
   * 让同轮对同一文件的多次 `str_replace` 累积到同一份提案上。必须是**请求级**的
   * （Python 侧在每次请求重建工具集时创建闭包缓存），因此由调用方注入而非模块级单例。
   */
  pendingProposals: PendingProposalContents;
  /** 图像服务（探测纯本地；编码经 RPC 走主进程的 nativeImage）。 */
  imageService: ImageService;
}

export interface ToolDefinition {
  name: string;
  description: string;
  kind: ToolKind;
  /** 参数校验器；同时用于生成 LLM 侧 JSON Schema。 */
  argsSchema: z.ZodType;
  /**
   * 已有的 JSON Schema。
   *
   * MCP 动态发现的工具自带 schema，直接透传比经 zod 往返更保真
   * （zod 无法无损表达 JSON Schema 的任意组合）。
   */
  rawParameters?: Record<string, unknown>;
  /**
   * 执行体。`proposal` 与 `async` 类工具没有执行体——前者由调度层生成提案，
   * 后者交给 Electron 执行。
   */
  execute?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => string | Promise<string>;
}

/** 剥掉 JSON Schema 中的 title（含嵌套），对齐 Pydantic 的 `_strip_titles`。 */
export function stripSchemaTitles(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaTitles);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === 'title') continue;
      out[key] = stripSchemaTitles(value);
    }
    return out;
  }
  return node;
}

/**
 * 把 zod schema 转为 OpenAI function calling 的 parameters。
 *
 * 归一化掉几个 OpenAI 不关心、但会占 token 的键：`$schema`、`title`、
 * `additionalProperties`。
 */
export function toParametersSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  delete raw.$schema;
  const cleaned = stripSchemaTitles(raw) as Record<string, unknown>;
  delete cleaned.additionalProperties;
  return cleaned;
}

/** 转为发给 LLM 的工具声明。 */
export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      // MCP 动态工具自带 schema，直接透传
      parameters:
        tool.rawParameters !== undefined
          ? tool.rawParameters
          : toParametersSchema(tool.argsSchema),
    },
  };
}

// ── 参数 schema ────────────────────────────────────────────────────
// 描述文本需与 registry.py 的 Field(description=...) 逐字一致。

const AutoAnnotateArgs = z.object({
  user_request: z
    .string()
    .min(1)
    .describe('本轮标注任务说明（按用户意图归纳）'),
  paths: z
    .array(z.string())
    .default([])
    .describe(
      '要标注的相对路径，取自 list_workspace_directory 的 relativePath；目录以 / 结尾',
    ),
  all_files: z
    .boolean()
    .default(false)
    .describe('是否标注整个项目全部文件（仅用户明确要求时为 true）'),
  write_mode: z
    .enum(['append', 'replace_matching'])
    .default('append')
    .describe('append 追加新标注；replace_matching 替换同类型已有标注'),
  scope_hint: z
    .string()
    .nullish()
    .describe('兼容旧参数：逗号分隔的相对路径，优先使用 paths'),
  conf_threshold: z
    .number()
    .min(0)
    .max(1)
    .nullish()
    .describe('检测置信度阈值（0-1），用户明确给出时填'),
  iou_threshold: z
    .number()
    .min(0)
    .max(1)
    .nullish()
    .describe('检测 NMS IoU 阈值（0-1），用户明确给出时填'),
  model_id: z
    .string()
    .nullish()
    .describe('指定检测模型 id，仅用户点名模型时填'),
  include_classes: z
    .array(z.string())
    .nullish()
    .describe('只保留这些检测类名的框（如 ["person"]）'),
  exclude_classes: z
    .array(z.string())
    .nullish()
    .describe('排除这些检测类名的框'),
  use_vision_mapping: z
    .boolean()
    .nullish()
    .describe('是否用视觉模型把检测框映射到项目标签；留空由系统决定'),
});

const MutateAnnotationArgs = z.object({
  user_request: z.string().min(1).describe('必须原样传递用户的原始请求'),
  paths: z
    .array(z.string())
    .nullish()
    .describe('要修改的文件相对路径。有明确文件时必须填写。'),
  annotation_ids: z
    .array(z.string())
    .nullish()
    .describe('画布选中或用户指定的标注 id。'),
});

// 参数名与 `src/main/mcp/server.ts` 的 start_terminal_command 保持一致，
// 前端 runTerminalCommandTool 按 command / args / timeout_ms 读取。
const StartTerminalCommandArgs = z.object({
  command: z
    .string()
    .describe(
      'Executable name or path, e.g. "git". Shell builtins and shell syntax (|, >, &&) are not supported',
    ),
  args: z
    .array(z.string())
    .max(128)
    .optional()
    .describe('Arguments passed verbatim as argv, e.g. ["status", "--short"]'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe(
      'Kill the command after this many ms (default 300000, max 600000)',
    ),
});

const ReadFileAnnotationArgs = z.object({
  relative_path: z.string().describe('文件相对路径（如 data/2.jpg）'),
  annotation_offset: z.number().int().default(0).describe('分页起始偏移'),
  annotation_limit: z.number().int().default(200).describe('单次返回条数上限'),
});

const ReadWorkspaceFileArgs = z.object({
  relative_path: z
    .string()
    .default('')
    .describe('相对路径；为空时使用当前打开的文件'),
  start_line: z.number().int().nullish().describe('起始行（1-indexed，含）'),
  end_line: z.number().int().nullish().describe('结束行（1-indexed，含）'),
});

const GrepArgs = z.object({
  pattern: z.string().describe('正则表达式'),
  path: z.string().default('').describe('相对目录或文件；空表示整个工作区'),
  glob_pattern: z.string().default('*').describe('文件匹配，如 *.py、*.ts'),
  case_insensitive: z.boolean().default(false).describe('是否忽略大小写'),
});

const GlobArgs = z.object({
  glob_pattern: z.string().describe('glob 表达式，如 **/*.py、src/**/*.ts'),
  relative_dir: z
    .string()
    .default('')
    .describe('起始目录；为空时从工作区根开始'),
});

const ListDirArgs = z.object({
  relative_dir: z
    .string()
    .default('')
    .describe('目录相对路径；为空时列出工作区根'),
});

const HelpArgs = z.object({
  topic: z.string().nullish().describe('可选 topic 关键词'),
});

const ReadImageArgs = z.object({
  relative_path: z
    .string()
    .default('')
    .describe('图片相对路径；为空时使用当前打开的图片'),
});

const ReadDocumentArgs = z.object({
  relative_path: z
    .string()
    .default('')
    .describe('文档相对路径；为空时使用当前打开的文件'),
});

const WriteFileArgs = z.object({
  relative_path: z.string().min(1).describe('要写入的相对路径'),
  content: z.string().describe('完整文件内容'),
});

const StrReplaceArgs = z.object({
  relative_path: z.string().min(1).describe('要修改的相对路径'),
  old_string: z.string().min(1).describe('文件中必须唯一出现的原文片段'),
  new_string: z.string().describe('替换后的文本'),
  replace_all: z
    .boolean()
    .default(false)
    .describe('为 true 时替换全部出现；默认要求 old_string 只出现一次'),
});

const DeleteFileArgs = z.object({
  relative_path: z.string().min(1).describe('要删除的相对路径'),
});

const MoveFileArgs = z.object({
  relative_path: z.string().min(1).describe('原相对路径'),
  new_relative_path: z
    .string()
    .min(1)
    .describe('新相对路径（同目录改名为重命名，跨目录为移动）'),
});

const ExploreReadonlyArgs = z.object({
  query: z.string().min(1).describe('要查阅的问题或目标'),
  focus_path: z.string().nullish().describe('可选，优先查阅的相对路径或目录'),
});

// ── 只读 / 元信息工具的实现 ────────────────────────────────────────

function accountSummary(): string {
  // 本地无状态模式（运行时注入匿名用户）：如实说明，不展示占位账户
  return '本地模式：LR-Agent 本地服务无云端账户体系，对话、标注与配置均保存在本机。';
}

function describeContext(clientContext: ClientContextLike | null): string {
  if (!clientContext) return '客户端未提供当前界面上下文。';
  const parts: string[] = [];
  if (clientContext.workspaceRoot) {
    parts.push(`工作区根目录: ${clientContext.workspaceRoot}`);
  }
  if (clientContext.activeFilePath) {
    parts.push(`当前打开文件: ${clientContext.activeFilePath}`);
  }
  if (clientContext.activeRelativePath) {
    parts.push(`当前打开文件（相对路径）: ${clientContext.activeRelativePath}`);
  }
  const ctx = clientContext as Record<string, unknown>;
  const projectId = ctx.activeAnnotationProjectId;
  if (projectId) parts.push(`当前标注项目 ID: ${String(projectId)}`);
  if (ctx.annotationProjectModality) {
    parts.push(`任务模态: ${String(ctx.annotationProjectModality)}`);
  }
  if (ctx.annotationProjectType) {
    parts.push(`标注类型: ${String(ctx.annotationProjectType)}`);
  }
  if (ctx.agentMode) parts.push(`交互模式: ${String(ctx.agentMode)}`);
  if (ctx.workMode) parts.push(`工作模式: ${String(ctx.workMode)}`);
  if (parts.length === 0) return '工作区已连接，但未打开具体文件或标注项目。';
  return parts.join('\n');
}

function describeAnnotationProject(
  clientContext: ClientContextLike | null,
): string {
  const snapshot = clientContext?.annotationProjectSnapshot;
  if (!clientContext || !snapshot) {
    return '当前未绑定标注项目快照。请确认用户已在标注任务中打开项目。';
  }
  return formatSnapshotForPrompt({
    projectId: String((snapshot as Record<string, unknown>).projectId ?? ''),
    name: String((snapshot as Record<string, unknown>).name ?? ''),
    modality: String((snapshot as Record<string, unknown>).modality ?? ''),
    annotationType: String(
      (snapshot as Record<string, unknown>).annotationType ?? '',
    ),
    labels: (snapshot as Record<string, unknown>).labels as
      Array<Record<string, unknown>> | undefined,
    detectionModels: (snapshot as Record<string, unknown>).detectionModels as
      Array<Record<string, unknown>> | undefined,
  });
}

/** LR-Agent 功能概览（get_lr_agent_help 的返回内容）。 */
export const LR_AGENT_HELP = `# LR-Agent 功能概览

- **资源管理器**：浏览本地文件夹与文件
- **标注任务**：创建与管理图像标注项目
- **预训练模型**：配置用于辅助标注的模型
- **大模型配置**：添加 OpenAI 兼容 API（如通义、DeepSeek）
- **Agent 面板**：右侧对话助手，可搜索/读取工作区代码与文档、看图、查已有标注、写文件提案（确认后落盘）；大范围摸底可用 explore_readonly

**Ask 模式**：问答、搜索代码、读文本/文档、看图；标注任务中还可查已有标注。不修改文件、不写入标注。
**编辑器 Agent**：可改代码/文档（提案确认后落盘），不能标注。
**标注任务 Agent**：批量检测与提案；标注变更（改标签/删框）；报告/文档（Markdown）。
执行批量写入或变更标注请传入明确 paths（或用户明确要求全部时 all_files=true）；查某张图已有标注在 Ask 即可。`;

/** 按 topic 关键词返回功能说明；无 topic 时返回完整概览。 */
export function getLrAgentHelp(topic?: string | null): string {
  if (!topic || !topic.trim()) return LR_AGENT_HELP;
  const needle = topic.trim().toLowerCase();
  if (needle.includes('标注') || needle.includes('annotation')) {
    return (
      '标注任务在左侧活动栏「标注任务」中创建。' +
      ' **Ask**：分析与建议，不修改文件、不执行批量标注。' +
      '**标注 Agent**：新增/重写用 auto_annotate，改已有标注用 mutate_annotation。' +
      '**编辑器 Agent**：只改代码/文档，不能标注。'
    );
  }
  if (needle.includes('模型') || needle.includes('model')) {
    return '预训练模型在左侧「预训练模型」面板配置，供标注工作区推理使用。';
  }
  if (needle.includes('agent') || needle.includes('对话')) {
    return 'Agent 在右侧活动栏打开，在「大模型配置」中添加 OpenAI 兼容 API Key 即可使用。';
  }
  return LR_AGENT_HELP;
}

// ── 工具清单 ───────────────────────────────────────────────────────

/**
 * 全部内置工具定义。
 *
 * 未注册 `execute` 的工具：`proposal` 类由调度层生成提案（阶段 3），
 * `async` 类交给 Electron 执行；`explore_readonly` 由子代理 runner 接管（阶段 6）。
 */
export function buildTools(): ToolDefinition[] {
  return [
    {
      name: 'get_account_summary',
      description: '获取当前登录用户的账户摘要（邮箱、验证状态、显示名）',
      kind: 'sync',
      argsSchema: z.object({}),
      execute: () => accountSummary(),
    },
    {
      name: 'get_lr_agent_help',
      description: '获取 LR-Agent 应用功能说明，可选 topic 关键词',
      kind: 'sync',
      argsSchema: HelpArgs,
      execute: (args) =>
        getLrAgentHelp(args.topic as string | null | undefined),
    },
    {
      name: 'describe_client_context',
      description:
        '描述用户当前 Electron 客户端界面上下文（工作区、打开文件、标注项目）',
      kind: 'sync',
      argsSchema: z.object({}),
      execute: (_args, ctx) => describeContext(ctx.clientContext),
    },
    {
      name: 'describe_annotation_project',
      description: '获取当前标注项目的标签树、任务类型、模态与可用检测模型列表',
      kind: 'sync',
      argsSchema: z.object({}),
      execute: (_args, ctx) => describeAnnotationProject(ctx.clientContext),
    },
    {
      name: 'read_file_annotation',
      description:
        '读取项目中某文件的已有标注（相对路径，如 data/2.jpg）。' +
        '标注较多时可用 annotation_offset/annotation_limit 分页（默认返回前 200 条）。' +
        '只读查询，不要用写文件工具回写。',
      kind: 'sync',
      argsSchema: ReadFileAnnotationArgs,
      execute: (args, ctx) =>
        readFileAnnotationTool(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          {
            offset: asInt(args.annotation_offset, 0),
            limit: asInt(args.annotation_limit, 200),
          },
        ),
    },
    {
      name: 'read_workspace_file',
      description:
        '读取工作区或项目内的文本/代码文件内容（如 .py .ts .md .json .yaml .txt）。' +
        'relative_path 为空时使用当前打开文件。' +
        '可选 start_line / end_line（1-indexed，含首尾）读取指定行范围。' +
        '返回内容带行号前缀（如 `    12|code`）。' +
        '找代码时建议先用 grep_workspace 或 glob_workspace 定位，再读本工具读具体行。',
      kind: 'sync',
      argsSchema: ReadWorkspaceFileArgs,
      execute: (args, ctx) =>
        readWorkspaceTextFile(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          {
            maxBytes: ctx.settings.readFileMaxBytes,
            maxLines: ctx.settings.readFileMaxLines,
            startLine: args.start_line as number | null | undefined,
            endLine: args.end_line as number | null | undefined,
          },
        ),
    },
    {
      name: 'grep_workspace',
      description:
        '在工作区内按正则搜索代码/文本，返回 path:line: content 格式。' +
        '找定义、引用、符号时优先使用；命中后再对具体文件调用 read_workspace_file。' +
        'pattern 为正则；path 为相对目录或文件（空=整个工作区）；' +
        'glob_pattern 可选如 *.py、*.ts。',
      kind: 'sync',
      argsSchema: GrepArgs,
      execute: (args, ctx) =>
        grepWorkspace(ctx.clientContext, String(args.pattern ?? ''), {
          maxResults: ctx.settings.grepMaxResults,
          maxFilesScanned: ctx.settings.grepMaxFilesScanned,
          path: String(args.path ?? ''),
          globPattern: String(args.glob_pattern ?? '*'),
          caseInsensitive: Boolean(args.case_insensitive),
        }),
    },
    {
      name: 'glob_workspace',
      description:
        '按 glob 递归列出工作区文件（如 **/*.py、src/**/*.ts）。' +
        'relative_dir 为空时从工作区根开始。跳过 .git / node_modules / .lr-agent。' +
        '找文件路径时优先于反复 list_workspace_directory。',
      kind: 'sync',
      argsSchema: GlobArgs,
      execute: (args, ctx) =>
        globWorkspace(ctx.clientContext, String(args.glob_pattern ?? ''), {
          relativeDir: String(args.relative_dir ?? ''),
          maxFilesScanned: ctx.settings.grepMaxFilesScanned,
        }),
    },
    {
      name: 'list_workspace_directory',
      description:
        '列出工作区目录下的文件与子目录（name | kind | relativePath）。' +
        'relative_dir 为空时列出工作区根；用于了解项目结构。',
      kind: 'sync',
      argsSchema: ListDirArgs,
      execute: (args, ctx) =>
        listWorkspaceDirectory(
          ctx.clientContext,
          String(args.relative_dir ?? ''),
          { maxEntries: ctx.settings.listDirMaxEntries },
        ),
    },
    {
      name: 'read_image_for_vision',
      description:
        '加载图片并在调用成功后由系统注入附图，供你直接根据像素回答' +
        '（场景、物体、人数、文字 OCR、外观等）。relative_path 为空时使用当前打开的图片。' +
        '需视觉探针通过；查已有标注请用 read_file_annotation，勿用本工具代替。',
      kind: 'sync',
      argsSchema: ReadImageArgs,
      execute: (args, ctx) =>
        readImageForVisionTool(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          {
            providerIsVision: ctx.providerIsVision,
            imageService: ctx.imageService,
          },
        ),
    },
    {
      name: 'read_document_file',
      description:
        '提取 PDF 或 DOCX 文档正文。relative_path 为空时使用当前打开的文件。',
      kind: 'sync',
      argsSchema: ReadDocumentArgs,
      execute: (args, ctx) =>
        readDocumentFile(ctx.clientContext, String(args.relative_path ?? ''), {
          maxPages: ctx.settings.readDocumentMaxPages,
          maxChars: ctx.settings.readFileMaxBytes,
        }),
    },
    {
      name: 'write_workspace_file',
      description:
        '在工作区内创建或覆写文本/代码文件（如 .md .py .ts）。' +
        '内容会直接写入磁盘，无需用户确认；用户可在对话中撤销。' +
        '只用于工作区文档与代码，不能用来保存标注。' +
        '删文件请用 delete_workspace_file，不要写入空内容；' +
        '移动/重命名文件请用 move_workspace_file。',
      kind: 'proposal',
      argsSchema: WriteFileArgs,
      execute: (args, ctx) =>
        writeWorkspaceFileTool(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          String(args.content ?? ''),
          ctx.pendingProposals,
        ),
    },
    {
      name: 'str_replace_workspace_file',
      description:
        '对已有文本/代码文件做精确片段替换。' +
        'old_string 必须在文件中唯一出现，除非 replace_all=true。' +
        '改局部代码时优先用本工具。不能用来改标注。',
      kind: 'proposal',
      argsSchema: StrReplaceArgs,
      execute: (args, ctx) =>
        strReplaceWorkspaceFileTool(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          String(args.old_string ?? ''),
          String(args.new_string ?? ''),
          Boolean(args.replace_all),
          ctx.pendingProposals,
        ),
    },
    {
      name: 'delete_workspace_file',
      description:
        '删除工作区内的文本/代码文件。' +
        '删除会直接生效，无需用户确认；用户可在对话中撤销。不能删除标注。',
      kind: 'proposal',
      argsSchema: DeleteFileArgs,
      execute: (args, ctx) =>
        deleteWorkspaceFileTool(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          ctx.pendingProposals,
        ),
    },
    {
      name: 'move_workspace_file',
      description:
        '移动或重命名工作区内的文本/代码文件。' +
        '变更会直接生效，无需用户确认；用户可在对话中撤销。' +
        '禁止用「读出内容再写到新路径」来移动文件。',
      kind: 'proposal',
      argsSchema: MoveFileArgs,
      execute: (args, ctx) =>
        moveWorkspaceFileTool(
          ctx.clientContext,
          String(args.relative_path ?? ''),
          String(args.new_relative_path ?? ''),
          ctx.pendingProposals,
        ),
    },
    {
      name: 'auto_annotate',
      description:
        '新增或重写当前项目的自动标注（检测、预标注、生成 caption 等）；' +
        '改已有框/标签用 mutate_annotation。填参规则见系统提示的标注调用纪律。',
      kind: 'async',
      argsSchema: AutoAnnotateArgs,
    },
    {
      name: 'mutate_annotation',
      description:
        '修改或删除已有标注（改标签、删框、改 caption 等）。' +
        '不含新增；新增请用 auto_annotate。',
      kind: 'async',
      argsSchema: MutateAnnotationArgs,
    },
    {
      name: 'start_terminal_command',
      description:
        'Run a terminal command in the current workspace (cwd is locked to it). ' +
        'Runs WITHOUT a shell: no pipes, redirections or command chains — split into multiple calls instead. ' +
        'Every execution requires explicit user approval in the chat UI before it starts, and destructive commands are rejected outright. ' +
        'Returns a job id; the tool result delivered to you contains the exit code and an output tail. ' +
        'Use read_terminal_output for the full/incremental output and kill_terminal_job to abort a long-running job.',
      kind: 'async',
      argsSchema: StartTerminalCommandArgs,
    },
    {
      name: 'explore_readonly',
      description:
        '只读查阅子代理：在工作区内搜索/阅读代码与文档' +
        '（标注任务还可读已有标注），返回中文摘要。' +
        '大范围摸底时使用。query 描述要查什么；focus_path 可选，缩小范围。' +
        '本工具不会改文件或写标注；标注与写文件必须由你直接调用对应工具。',
      kind: 'sync',
      argsSchema: ExploreReadonlyArgs,
      // 阶段 6 由 ExploreReadonlyRunner 接管，不走普通 execute
    },
  ];
}

/** 工具名 → 定义。 */
export function toolsByName(): Map<string, ToolDefinition> {
  return new Map(buildTools().map((tool) => [tool.name, tool]));
}

/** 构建指定名称子集的工具声明（发给 LLM 用）。 */
export function buildToolSpecs(
  toolSet: ReadonlySet<string>,
  tools: Map<string, ToolDefinition>,
): ToolSpec[] {
  const specs: ToolSpec[] = [];
  for (const [name, tool] of tools) {
    if (toolSet.has(name)) specs.push(toToolSpec(tool));
  }
  // tools 列表按名称排序后固定：阶段门禁不在 bind 期增删工具，避免破坏 LLM 前缀缓存
  return specs.sort((a, b) => (a.function.name < b.function.name ? -1 : 1));
}

/** 构造统一失败结果（供调度层复用）。 */
export function toolFailure(
  tool: string,
  status: string,
  summary: string,
): string {
  return buildToolResult({ ok: false, tool, status, summary });
}

/** 宽松的整数取值：非数字时回退默认值（模型可能传字符串或省略）。 */
function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

/**
 * Agent 运行时配置。
 *
 * 对应 `vendor/local-agent/app/core/config.py` 的 Agent 编排相关字段。
 * 默认值必须与协议文档 §11 一致——它们会直接改变工具结果的文本内容，
 * 进而影响 LLM 行为与 golden 基线。
 *
 * 目前只需要工具层用到的字段；后续阶段（循环预算、MCP TTL、标注温度等）
 * 按需补充。
 */

export interface AgentSettings {
  /** 主 Agent 工具轮上限。 */
  maxToolRounds: number;
  /** 子代理（explore_readonly）工具轮上限。 */
  subagentMaxToolRounds: number;
  /** 单文件读取字节上限（512KB）。 */
  readFileMaxBytes: number;
  /** 单文件读取行数上限。 */
  readFileMaxLines: number;
  /** 文档（PDF/DOCX）提取页数上限。 */
  readDocumentMaxPages: number;
  /** grep 结果上限。 */
  grepMaxResults: number;
  /** grep / glob 扫描文件数上限。 */
  grepMaxFilesScanned: number;
  /** 列目录条目上限。 */
  listDirMaxEntries: number;
  /** Chat 附图最长边。 */
  chatVisionMaxEdge: number;
  /** Chat 附图 JPEG 质量。 */
  chatVisionJpegQuality: number;
  /** MCP 工具发现结果缓存 TTL（秒）。 */
  mcpToolsTtlSeconds: number;
  /** 标注变更功能开关。 */
  mutationEnabled: boolean;
  /** 标注 LLM 温度（视觉映射等）。 */
  annotationLlmTemperature: number;
  /** 标注准备阶段温度（mutation-prepare 等）。 */
  annotationPrepareTemperature: number;
  /** 生成类标注送 LLM 的图片最长边。 */
  annotationLlmImageMaxEdge: number;
  /** 生成类标注图片 JPEG 质量。 */
  annotationLlmImageJpegQuality: number;
  /** 视觉映射并发度。 */
  annotationVisionMapConcurrency: number;
  /** 视觉映射是否校验。 */
  annotationVisionMapValidate: boolean;
  /** 视觉映射重试次数。 */
  annotationVisionMapMaxRetries: number;
  /** 标签池预检模式（off / auto / always）。 */
  annotationLabelPoolPreflight: 'off' | 'auto' | 'always';
  /** 标签池预检最小额外标签数。 */
  annotationLabelPoolPreflightMinExtra: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  maxToolRounds: 30,
  subagentMaxToolRounds: 12,
  readFileMaxBytes: 524_288,
  readFileMaxLines: 2000,
  readDocumentMaxPages: 30,
  grepMaxResults: 100,
  grepMaxFilesScanned: 1000,
  listDirMaxEntries: 80,
  chatVisionMaxEdge: 1280,
  chatVisionJpegQuality: 85,
  mcpToolsTtlSeconds: 1800,
  mutationEnabled: true,
  annotationLlmTemperature: 0.0,
  annotationPrepareTemperature: 0.1,
  annotationLlmImageMaxEdge: 1280,
  annotationLlmImageJpegQuality: 85,
  annotationVisionMapConcurrency: 3,
  annotationVisionMapValidate: true,
  annotationVisionMapMaxRetries: 1,
  annotationLabelPoolPreflight: 'auto',
  annotationLabelPoolPreflightMinExtra: 2,
};

/** 运行时可覆盖的配置（环境变量 → 覆盖默认值），便于对拍与调试。 */
export function loadAgentSettings(): AgentSettings {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    ...DEFAULT_AGENT_SETTINGS,
    maxToolRounds: num('LR_AGENT_MAX_TOOL_ROUNDS', DEFAULT_AGENT_SETTINGS.maxToolRounds),
    readFileMaxBytes: num(
      'LR_AGENT_READ_FILE_MAX_BYTES',
      DEFAULT_AGENT_SETTINGS.readFileMaxBytes,
    ),
    readFileMaxLines: num(
      'LR_AGENT_READ_FILE_MAX_LINES',
      DEFAULT_AGENT_SETTINGS.readFileMaxLines,
    ),
    grepMaxResults: num(
      'LR_AGENT_GREP_MAX_RESULTS',
      DEFAULT_AGENT_SETTINGS.grepMaxResults,
    ),
    grepMaxFilesScanned: num(
      'LR_AGENT_GREP_MAX_FILES_SCANNED',
      DEFAULT_AGENT_SETTINGS.grepMaxFilesScanned,
    ),
    listDirMaxEntries: num(
      'LR_AGENT_LIST_DIR_MAX_ENTRIES',
      DEFAULT_AGENT_SETTINGS.listDirMaxEntries,
    ),
  };
}

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
  /** 逐框视觉映射送的候选标签上限（细粒度大标签集需调高，否则尾部标签永远选不到）。 */
  annotationVisionCandidateLimit: number;
  /** 标签池整图 preflight 送的候选标签上限。 */
  annotationPreflightCandidateLimit: number;
  /** mutation 规划送 LLM 的标签名上限。 */
  annotationMutationLabelNameLimit: number;
  /**
   * 标签唯一性策略。
   * - allow：允许同一标签分配给多个框（类别型/细粒度标签，默认）
   * - enforce：每框标签唯一（球员名等实例型标签）
   */
  annotationLabelUniqueness: 'allow' | 'enforce';
  /**
   * 主循环每轮显式下发的 `max_tokens`（0 表示不下发，沿用 provider 默认）。
   *
   * 显式下发是「输出截断恢复」的前提：只有知道上限，`finish_reason=length`
   * 时才谈得上「升档重试」。
   */
  chatMaxOutputTokens: number;
  /** 首轮静默升档后的 `max_tokens`（仅当本轮尚无任何输出时使用）。 */
  chatMaxOutputTokensBumped: number;
  /** 输出截断后的续写次数上限（超过即正常收尾）。 */
  outputRecoveryMaxAttempts: number;
  /** 是否启用「上下文超长（HTTP 4xx）→ 运行时压缩后重试」。 */
  reactiveCompactEnabled: boolean;
  /** 运行时压缩时保留的末尾轮数（每轮按 2 条消息计）。 */
  reactiveCompactKeepTurns: number;
  /**
   * 可重取工具结果的字符上限；超过则折叠为预览 + 重取提示（0 表示关闭）。
   *
   * 只读类工具（read/grep/glob/list）结果通常可以再次获取，故可安全截断。
   */
  toolResultPreviewBytes: number;
  /** 折叠大结果时保留的预览字符数。 */
  toolResultPreviewChars: number;
  /**
   * 循环内上下文预算（tokens）；0 表示关闭循环内 microcompact。
   *
   * 默认关闭以保持既有行为；开启后，单轮工具结果累积超预算时会清理旧的
   * **可重取**工具结果内容（本地操作、零 API 开销）。
   */
  contextTokenBudget: number;
  /** 触发 microcompact 的预算占比。 */
  contextCompactRatio: number;
  /** microcompact 保留的最近工具结果条数（更旧的才可清理）。 */
  microCompactKeepRecentToolResults: number;
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
  annotationVisionCandidateLimit: 300,
  annotationPreflightCandidateLimit: 500,
  annotationMutationLabelNameLimit: 300,
  annotationLabelUniqueness: 'allow',
  // 0 = 不下发 max_tokens，保持与既有行为完全一致（provider 默认）。
  // 显式设置后才启用「静默升档」；截断续写恢复不依赖它。
  chatMaxOutputTokens: 0,
  chatMaxOutputTokensBumped: 65536,
  outputRecoveryMaxAttempts: 3,
  reactiveCompactEnabled: true,
  reactiveCompactKeepTurns: 4,
  toolResultPreviewBytes: 50_000,
  toolResultPreviewChars: 2_000,
  contextTokenBudget: 0,
  contextCompactRatio: 0.85,
  microCompactKeepRecentToolResults: 5,
};

/** 运行时可覆盖的配置（环境变量 → 覆盖默认值），便于对拍与调试。 */
export function loadAgentSettings(): AgentSettings {
  const num = (key: string, fallback: number): number => {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = process.env[key];
    if (raw == null || raw === '') return fallback;
    return /^(1|true|yes|on)$/i.test(raw);
  };
  const labelUniqueness: AgentSettings['annotationLabelUniqueness'] =
    (process.env.LR_AGENT_LABEL_UNIQUENESS ?? '').trim().toLowerCase() ===
    'enforce'
      ? 'enforce'
      : DEFAULT_AGENT_SETTINGS.annotationLabelUniqueness;
  return {
    ...DEFAULT_AGENT_SETTINGS,
    maxToolRounds: num(
      'LR_AGENT_MAX_TOOL_ROUNDS',
      DEFAULT_AGENT_SETTINGS.maxToolRounds,
    ),
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
    chatMaxOutputTokens: num(
      'LR_AGENT_CHAT_MAX_OUTPUT_TOKENS',
      DEFAULT_AGENT_SETTINGS.chatMaxOutputTokens,
    ),
    chatMaxOutputTokensBumped: num(
      'LR_AGENT_CHAT_MAX_OUTPUT_TOKENS_BUMPED',
      DEFAULT_AGENT_SETTINGS.chatMaxOutputTokensBumped,
    ),
    outputRecoveryMaxAttempts: num(
      'LR_AGENT_OUTPUT_RECOVERY_MAX_ATTEMPTS',
      DEFAULT_AGENT_SETTINGS.outputRecoveryMaxAttempts,
    ),
    reactiveCompactEnabled: bool(
      'LR_AGENT_REACTIVE_COMPACT',
      DEFAULT_AGENT_SETTINGS.reactiveCompactEnabled,
    ),
    reactiveCompactKeepTurns: num(
      'LR_AGENT_REACTIVE_COMPACT_KEEP_TURNS',
      DEFAULT_AGENT_SETTINGS.reactiveCompactKeepTurns,
    ),
    toolResultPreviewBytes: num(
      'LR_AGENT_TOOL_RESULT_PREVIEW_BYTES',
      DEFAULT_AGENT_SETTINGS.toolResultPreviewBytes,
    ),
    toolResultPreviewChars: num(
      'LR_AGENT_TOOL_RESULT_PREVIEW_CHARS',
      DEFAULT_AGENT_SETTINGS.toolResultPreviewChars,
    ),
    contextTokenBudget: num(
      'LR_AGENT_CONTEXT_TOKEN_BUDGET',
      DEFAULT_AGENT_SETTINGS.contextTokenBudget,
    ),
    contextCompactRatio: num(
      'LR_AGENT_CONTEXT_COMPACT_RATIO',
      DEFAULT_AGENT_SETTINGS.contextCompactRatio,
    ),
    microCompactKeepRecentToolResults: num(
      'LR_AGENT_MICRO_COMPACT_KEEP_RECENT',
      DEFAULT_AGENT_SETTINGS.microCompactKeepRecentToolResults,
    ),
    annotationVisionCandidateLimit: num(
      'LR_AGENT_VISION_CANDIDATE_LIMIT',
      DEFAULT_AGENT_SETTINGS.annotationVisionCandidateLimit,
    ),
    annotationPreflightCandidateLimit: num(
      'LR_AGENT_PREFLIGHT_CANDIDATE_LIMIT',
      DEFAULT_AGENT_SETTINGS.annotationPreflightCandidateLimit,
    ),
    annotationMutationLabelNameLimit: num(
      'LR_AGENT_MUTATION_LABEL_NAME_LIMIT',
      DEFAULT_AGENT_SETTINGS.annotationMutationLabelNameLimit,
    ),
    annotationLabelUniqueness: labelUniqueness,
  };
}

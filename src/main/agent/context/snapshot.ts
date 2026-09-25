/**
 * 客户端上下文快照格式化与身份块。
 *
 * 移植自 `vendor/local-agent/app/agent/context_snapshot.py`。
 *
 * 本模块只包含「工具与 prompt 共用的格式化片段」；完整的 system prompt 分块组装
 * 在阶段 5 补齐（顺序固定，不可调整——详见协议文档 §9.1）。
 */

/** 标注项目快照输入。 */
export interface AnnotationProjectSnapshot {
  projectId: string;
  name?: string;
  modality?: string;
  annotationType?: string;
  labels?: Array<Record<string, unknown>>;
  detectionModels?: Array<Record<string, unknown>>;
  projectDirectoryPath?: string | null;
}

/** 看图与查标注的固定提示。 */
export const VISION_HINT = `- 看图描述：按需调用 read_image_for_vision。
- 查已有标注：read_file_annotation。`;

/** 工作区助手任务段（`{vision_hint}` 需替换为 VISION_HINT）。 */
export const WORKSPACE_ASSIST_TASK = `【任务】在 LR-Agent 内回答用户问题，按需使用工具完成读/写/分析操作。
{vision_hint}
- 大范围摸底用 explore_readonly；独立摸底可一次发起多个（不同 query / focus_path），它们会并行执行。标注与改文件必须由主 Agent 调对应工具。
- 用自然、简洁的中文回复。
- 调用工具前先用一两句中文说明下一步要做什么。`;

/** 标注/工作区 Agent 的任务段（`{vision_hint}` 需替换）。 */
export const ASSISTANT_TASK_BASE = `【任务】在 LR-Agent 内完成问答、标注、分析、写文件。
- 新增/重写标注用 auto_annotate；改已有标注用 mutate_annotation。不要用写文件工具保存标注。
- 写文件工具只用于工作区文档与代码。
- 大范围摸底用 explore_readonly；独立摸底可一次发起多个（不同 query / focus_path），它们会并行执行。标注与改文件必须由主 Agent 调对应工具。
{vision_hint}
- 未收到工具返回前，禁止输出执行结果、统计数字或完成声明；不得用文本假装执行了工具。
- 报告与汇总中的每个数字必须来自工具返回或提案明细，禁止估算或凭印象填写。
- 用简洁中文回复；调用工具前用一两句说明下一步。`;

/** 文件编辑纪律（仅允许写工作区的模式注入）。 */
export const FILE_EDIT_GUIDE = `【文件编辑纪律】
- 修改已有文件的局部内容时，必须优先用 str_replace_workspace_file（old_string → new_string），禁止用 write_workspace_file 整文件重写来改几行。
- 编辑前必须先 read_workspace_file 看原文；old_string 从真实原文中原样复制（含缩进与空白），禁止凭记忆编写。
- old_string 取最小但唯一的片段：太短容易命中多处，必要时前后多带几行上下文。
- new_string 保持与上下文一致的缩进与换行风格；替换后的全文必须是合法代码/文档。
- 同一文件多处修改：连续多次调用 str_replace_workspace_file（提案自动累积为一份），不要为省事整文件重写。`;

/** 标注调用纪律（仅标注 Agent 注入）。 */
export const ANNOTATION_CALL_GUIDE = `【标注调用纪律】(auto_annotate)
- paths 取自 list_workspace_directory 的 relativePath，目录以 / 结尾（如 data/）；用户点了文件或文件夹必须填 paths。
- all_files 仅在用户明确要求标注整个项目/全部文件时为 true；未确认时禁止默认为 true。
- 用户说“重写 / 重新标注 / 每文件只留一条”用 write_mode=replace_matching，否则用 append。
- conf_threshold / iou_threshold 仅在用户明确给出数值时填，否则留空用模型默认值。
- model_id 仅在用户点名检测模型时填（可用模型见 describe_annotation_project）。
- include_classes / exclude_classes 仅在用户说“只标 X / 不要 Y”时填，类名以检测模型输出为准。
- use_vision_mapping 留空由系统按标签情况决定；标签为实例/细粒度（球员名等）时填 true。
- unique_labels_per_box 仅在用户明确要求「每个框标签唯一/不允许重复标签」（如球员名一人一标签）时填 true；默认留空，同类多实例（如同一商品多瓶）允许共用同一标签。
- 所有参数以用户本轮原话为依据，禁止凭猜测补值。`;

export const ANNOTATION_SCOPE_HINT =
  '【标注工具】paths 填 list_workspace_directory 的 relativePath；全部文件才设 all_files=true。';

/** 已知标注类型（13 种）。 */
export const ANNOTATION_KNOWN_TYPES = new Set([
  'bbox',
  'caption',
  'classification',
  'polygon',
  'keypoint',
  'rotated_bbox',
  'span_ner',
  'text_classification',
  'instruction',
  'preference',
  'conversation',
  'cot',
]);

/** 特殊标注类型的额外提示。 */
export const ANNOTATION_TYPE_EXTRAS: Record<string, string> = {
  polygon: '需配置检测模型与 SAM2 分割模型。',
  keypoint: '需先选择骨架模板并配置关键点模型。',
  rotated_bbox: '需配置 OBB 检测模型。',
};

/** 需要展示检测模型列表的标注类型。 */
export const DETECTION_MODEL_TYPES = new Set([
  'bbox',
  'polygon',
  'keypoint',
  'rotated_bbox',
]);

/**
 * 运行时身份块。
 *
 * `providerLabel` 在本地路径固定为 `"local"`（由调用方传入）。
 */
export function formatRuntimeIdentityBlock(params: {
  model: string;
  providerLabel?: string;
  supportsVision?: boolean;
}): string {
  const label = (params.providerLabel ?? '').trim() || '（未命名提供商）';
  const visionLine = params.supportsVision
    ? '视觉能力：已通过 API 探针，可调用 read_image_for_vision 并在调用后查看附图。'
    : '视觉能力：未通过探针或未检测。不要声称能分析图片像素；' +
      '若用户要看图，说明需在「大模型配置」中选用支持视觉的模型并重新检测视觉。';
  return (
    '【你的身份】\n' +
    `- 你是后端模型 \`${params.model}\`（配置名称：${label}）。\n` +
    `- ${visionLine}\n` +
    '- 你在 LR-Agent 系统内与用户对话、调用工具完成任务；不要把自己说成独立的「LR-Agent 助手」或其它品牌模型。'
  );
}

/**
 * 标注项目快照格式化（用于 prompt 注入与 describe_annotation_project 工具）。
 *
 * 标签最多 40 条、检测模型最多 12 条。
 */
export function formatSnapshotForPrompt(
  snapshot: AnnotationProjectSnapshot,
): string {
  const labels = snapshot.labels ?? [];
  const labelLines = labels
    .slice(0, 40)
    .filter((item) => item && typeof item === 'object')
    .map((item) => `- ${String(item.id ?? '')}: ${String(item.name ?? '')}`);

  const annotationType = snapshot.annotationType ?? '';
  const lines: string[] = [
    `项目 ID: ${snapshot.projectId}`,
    `项目名称: ${snapshot.name ?? ''}`,
    `模态: ${snapshot.modality ?? ''}`,
    `标注类型: ${annotationType}`,
    '标签列表:',
    ...(labelLines.length ? labelLines : ['- （无）']),
  ];

  // 仅在目标检测类标注类型时展示可用的检测模型
  if (DETECTION_MODEL_TYPES.has(annotationType)) {
    const models = snapshot.detectionModels ?? [];
    const modelLines = models
      .slice(0, 12)
      .filter((m) => m && typeof m === 'object')
      .map(
        (m) =>
          `- ${String(m.id ?? '')}: ${String(m.name ?? '')}${
            m.is_default ? ' (默认)' : ''
          }`,
      );
    lines.push('可用检测模型（object_detection）:');
    lines.push(...(modelLines.length ? modelLines : ['- （未配置或未传入）']));
  }

  if (ANNOTATION_KNOWN_TYPES.has(annotationType)) {
    const extra = ANNOTATION_TYPE_EXTRAS[annotationType];
    lines.push(
      extra ? `${ANNOTATION_SCOPE_HINT} ${extra}` : ANNOTATION_SCOPE_HINT,
    );
  }

  return lines.join('\n');
}

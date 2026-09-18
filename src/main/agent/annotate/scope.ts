/**
 * 标注范围（scope）：从用户文本推断「只标 X / 不要 Y」的约束。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/annotation_scope.py`。
 *
 * 三个易错细节：
 *   1. `ONLY_ANNOTATE_RE` 与 `EXCLUDE_RE` 的**可选动词组不同**（后者少了
 *      `识别` / `打框` / `标出`）——不要"顺手统一"。
 *   2. `filterLabelCandidatesByScope` 的匹配是**去空格+小写后的精确相等**，
 *      且候选名只 lower、**不 strip**（scope 侧由校验器 strip）。
 *   3. 过滤后为空时**回退返回原始全量候选**（视为 scope 失效）。
 */

export interface AnnotationScopePayload {
  scope_summary: string;
  include_detection_labels: string[];
  exclude_detection_labels: string[];
  include_label_names: string[];
  exclude_label_names: string[];
}

/** 中文关键词 → 检测类名别名（逐字对齐 Python 的字典）。 */
export const SCOPE_KEYWORD_TO_DETECTION: Record<string, string[]> = {
  人脸: ['person', 'face'],
  面部: ['person', 'face'],
  人体: ['person'],
  人物: ['person'],
  人: ['person'],
  球员: ['person'],
  篮球: ['sports ball', 'basketball'],
  球: ['sports ball', 'basketball', 'ball'],
  汽车: ['car'],
  车: ['car'],
  猫: ['cat'],
  狗: ['dog'],
};

/**
 * 「只/仅」范围提取正则。
 *
 * 注意：JS 的 `.` 默认不匹配换行，与 Python 一致，故无需 `s` 标志。
 */
const ONLY_ANNOTATE_RE = /(?:只|仅)(?:标注|标|检测|框选|识别|打框|标出)?(.{1,24})/g;

/** 「不要/排除」范围提取正则（可选动词组比 ONLY 少三项）。 */
const EXCLUDE_RE = /(?:不要|别|排除|不包括|无需|不用)(?:标注|标|检测|框选)?(.{1,24})/g;

/** 范围模型。 */
export class AnnotationScope {
  scope_summary = '';

  include_detection_labels: string[] = [];

  exclude_detection_labels: string[] = [];

  include_label_names: string[] = [];

  exclude_label_names: string[] = [];

  /** 从任意输入构造（null / payload / 普通对象）。 */
  static fromPayload(
    payload: AnnotationScopePayload | Record<string, unknown> | null | undefined,
  ): AnnotationScope {
    const scope = new AnnotationScope();
    if (!payload) return scope;
    const record = payload as Record<string, unknown>;
    scope.scope_summary =
      typeof record.scope_summary === 'string' ? record.scope_summary : '';
    scope.include_detection_labels = coerceStrList(record.include_detection_labels);
    scope.exclude_detection_labels = coerceStrList(record.exclude_detection_labels);
    scope.include_label_names = coerceStrList(record.include_label_names);
    scope.exclude_label_names = coerceStrList(record.exclude_label_names);
    return scope;
  }

  toPayload(): AnnotationScopePayload {
    return {
      scope_summary: this.scope_summary,
      include_detection_labels: [...this.include_detection_labels],
      exclude_detection_labels: [...this.exclude_detection_labels],
      include_label_names: [...this.include_label_names],
      exclude_label_names: [...this.exclude_label_names],
    };
  }

  isRestricted(): boolean {
    return Boolean(
      this.scope_summary.trim() ||
        this.include_detection_labels.length ||
        this.exclude_detection_labels.length ||
        this.include_label_names.length ||
        this.exclude_label_names.length,
    );
  }
}

/**
 * Pydantic `field_validator(mode="before")` 的等价实现。
 *
 * 非字符串、非数组一律收成空数组（含数字、对象等异常输入）。
 */
export function coerceStrList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

/** 归一化检测类名：strip → lower → `_` 换空格 → 折叠连续空白。 */
export function normalizeDetectionLabel(label: string): string {
  return (label ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * 把中文关键词展开为检测类名别名。
 *
 * 用**原样 term**（未小写）查表；去重键是归一化后的值，但**输出原值**。
 */
export function expandDetectionAliases(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const term of terms) {
    const t = (term ?? '').trim();
    if (!t) continue;
    const aliases = SCOPE_KEYWORD_TO_DETECTION[t] ?? [t];
    for (const alias of aliases) {
      const nc = normalizeDetectionLabel(alias);
      if (nc && !seen.has(nc)) {
        seen.add(nc);
        out.push(alias);
      }
    }
  }
  return out;
}

/** 提取范围词：取分隔符切分后的第一段。 */
function extractScopeTerms(text: string, pattern: RegExp): string[] {
  const terms: string[] = [];
  // 每次调用重置 lastIndex（正则有 g 标志）
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    let chunk = (match[1] ?? '').trim();
    chunk = chunk.split(/[，。；;、和与及\s]+/)[0]?.trim() ?? '';
    if (chunk && chunk.length <= 24) terms.push(chunk);
  }
  return terms;
}

/** 保序去重（等价 `list(dict.fromkeys(...))`）。 */
function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * 从用户文本推断标注范围。
 *
 * summary 的赋值顺序有讲究：include 侧的**最后一个**命中覆盖前面的；
 * exclude 侧只在 summary 仍为空时生效（**第一个**排除词生效）。
 */
export function inferAnnotationScopeFromText(
  userText: string,
  options: { labelNames?: string[] } = {},
): AnnotationScope {
  const text = (userText ?? '').trim();
  const scope = new AnnotationScope();
  if (!text) return scope;

  const includeTerms = extractScopeTerms(text, ONLY_ANNOTATE_RE);
  const excludeTerms = extractScopeTerms(text, EXCLUDE_RE);

  const includeDet: string[] = [];
  const excludeDet: string[] = [];
  const includeLabels: string[] = [];

  for (const term of includeTerms) {
    includeDet.push(...expandDetectionAliases([term]));
    if (
      term in SCOPE_KEYWORD_TO_DETECTION ||
      ['人脸', '面部', '人物', '人体'].includes(term)
    ) {
      scope.scope_summary = `仅标注${term}`;
    }
  }

  if (includeTerms.length === 0) {
    if (['人脸', '面部'].some((k) => text.includes(k))) {
      includeDet.push(...expandDetectionAliases(['人脸']));
      if (!scope.scope_summary) scope.scope_summary = '仅标注人脸/人物';
    } else if (text.includes('人物') && text.includes('标注')) {
      includeDet.push(...expandDetectionAliases(['人物']));
      if (!scope.scope_summary) scope.scope_summary = '仅标注人物';
    }
  }

  for (const term of excludeTerms) {
    excludeDet.push(...expandDetectionAliases([term]));
    if (!scope.scope_summary) scope.scope_summary = `排除${term}`;
  }

  // 特殊规则：篮球 + 否定词
  if (
    ['篮球', '球'].some((k) => text.includes(k)) &&
    ['不要', '别', '排除', '不包括', '无需'].some((k) => text.includes(k))
  ) {
    excludeDet.push(...expandDetectionAliases(['篮球']));
  }

  for (const name of options.labelNames ?? []) {
    if (name && text.includes(name) && ['只', '仅'].some((k) => text.includes(k))) {
      includeLabels.push(name);
    }
  }

  scope.include_detection_labels = dedupe(includeDet);
  scope.exclude_detection_labels = dedupe(excludeDet);
  scope.include_label_names = dedupe(includeLabels);
  // exclude_label_names 推断从不产出，恒为空
  return scope;
}

/**
 * 合并已有 scope 与从文本推断的 scope。
 *
 * 规则：**base 该字段为空则用 inferred 覆盖**（取并集）。
 */
export function mergeAnnotationScope(
  scope: AnnotationScopePayload | Record<string, unknown> | null | undefined,
  userText: string,
  options: { labelNames?: string[] } = {},
): AnnotationScope {
  const base = AnnotationScope.fromPayload(scope ?? null);
  const inferred = inferAnnotationScopeFromText(userText, options);

  if (!base.scope_summary.trim() && inferred.scope_summary.trim()) {
    base.scope_summary = inferred.scope_summary;
  }
  if (
    base.include_detection_labels.length === 0 &&
    inferred.include_detection_labels.length > 0
  ) {
    base.include_detection_labels = inferred.include_detection_labels;
  }
  if (
    base.exclude_detection_labels.length === 0 &&
    inferred.exclude_detection_labels.length > 0
  ) {
    base.exclude_detection_labels = inferred.exclude_detection_labels;
  }
  if (
    base.include_label_names.length === 0 &&
    inferred.include_label_names.length > 0
  ) {
    base.include_label_names = inferred.include_label_names;
  }
  if (
    base.exclude_label_names.length === 0 &&
    inferred.exclude_label_names.length > 0
  ) {
    base.exclude_label_names = inferred.exclude_label_names;
  }
  return base;
}

/**
 * 按 scope 的标签名过滤候选。
 *
 * **匹配语义是精确相等**（去空格 + 小写），不是子串；检测类名字段不参与过滤。
 * 过滤后为空时回退返回原始全量。
 */
export function filterLabelCandidatesByScope(
  candidates: Array<Record<string, unknown>>,
  scope: AnnotationScope,
): Array<Record<string, unknown>> {
  if (
    scope.include_label_names.length === 0 &&
    scope.exclude_label_names.length === 0
  ) {
    return candidates;
  }

  const include = new Set(scope.include_label_names.map((n) => n.toLowerCase()));
  const exclude = new Set(scope.exclude_label_names.map((n) => n.toLowerCase()));

  const filtered: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    // 候选侧只 lower、不 strip（与 Python 一致）
    const name = String(candidate.name ?? '').toLowerCase();
    if (exclude.size > 0 && exclude.has(name)) continue;
    if (include.size > 0) {
      if (include.has(name)) filtered.push(candidate);
    } else {
      filtered.push(candidate);
    }
  }

  return filtered.length > 0 ? filtered : candidates;
}

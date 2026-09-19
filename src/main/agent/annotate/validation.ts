/**
 * 视觉映射结果校验。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/map_validation_service.py`。
 *
 * 四条规则按 A→D 顺序执行，问题按追加顺序返回：
 *   A. `invalid_label_id` —— label_id 不在候选中；**该框跳过后续全部校验**
 *   B. `duplicate_label` —— 同一标签分配给多个框（仅实例标签场景）
 *   C. `reason_contradicts_label` —— reason 表示无法确定，却返回了非空 label_id
 *   D. `reason_name_mismatch` —— reason 中恰好提到**一个**候选名且与 label_id 不符
 *
 * 规则 D 的「恰好一个」是关键：0 个或多于 1 个都**不报错**（避免误伤）。
 */

import { pyIntListRepr, pyRepr } from './common';

export const MappingIssueCode = {
  DUPLICATE_LABEL: 'duplicate_label',
  REASON_NAME_MISMATCH: 'reason_name_mismatch',
  REASON_CONTRADICTS_LABEL: 'reason_contradicts_label',
  INVALID_LABEL_ID: 'invalid_label_id',
} as const;

export type MappingIssueCodeType =
  (typeof MappingIssueCode)[keyof typeof MappingIssueCode];

export interface MappingIssue {
  boxIndex: number;
  code: MappingIssueCodeType;
  message: string;
}

export class ValidationResult {
  readonly issues: MappingIssue[];

  constructor(issues: MappingIssue[] = []) {
    this.issues = issues;
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  /** 某个框的全部问题（可能含多个 code）。 */
  issuesForBox(boxIndex: number): MappingIssue[] {
    return this.issues.filter((i) => i.boxIndex === boxIndex);
  }
}

/** reason 中表示「无法确定」的表述（大小写不敏感子串）。 */
const REASON_CONTRADICT_RE =
  /无法确认|无法确定|无法选择|不能确定|不符|不匹配|无关|cannot determine|not sure|no match|does not match|unable to/i;

/** 标签名 → label_id（同名后者覆盖前者）。 */
function nameToId(
  candidates: Array<Record<string, unknown>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of candidates) {
    const name = String(c.name ?? '')
      .trim()
      .toLowerCase();
    const id = String(c.id ?? '').trim();
    if (name && id) out.set(name, id);
  }
  return out;
}

/**
 * 找出文本中出现的候选标签名。
 *
 * 返回**原始大小写**的名字，按候选顺序，按 lower 去重。
 */
export function findLabelNamesInText(
  text: string,
  candidates: Array<Record<string, unknown>>,
): string[] {
  const raw = (text ?? '').toLowerCase();
  if (!raw) return [];

  const seen = new Set<string>();
  const hits: string[] = [];
  for (const c of candidates) {
    const name = String(c.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (raw.includes(key)) {
      seen.add(key);
      hits.push(name);
    }
  }
  return hits;
}

/** 把问题列表格式化为重试提示（`；` 分隔）。 */
export function formatIssuesForRetry(issues: MappingIssue[]): string {
  if (issues.length === 0) return '';
  return issues.map((i) => `[${i.code}] ${i.message}`).join('；');
}

/**
 * 为某个重试框筛出可选候选。
 *
 * 排除已被其它框占用的 label_id，但**保留该框原本选择的 label_id**。
 * 若全部被排除则回退返回全量（避免无候选可选）。
 */
export function candidatesForRetryBox(
  candidates: Array<Record<string, unknown>>,
  usedLabelIds: ReadonlySet<string>,
  keepLabelId = '',
): Array<Record<string, unknown>> {
  if (usedLabelIds.size === 0) return candidates;

  const keep = keepLabelId.trim();
  const filtered = candidates.filter((c) => {
    const id = String(c.id ?? '');
    return !usedLabelIds.has(id) || id === keep;
  });

  return filtered.length > 0 ? filtered : candidates;
}

export interface ValidateParams {
  mappings: Array<Record<string, unknown>>;
  candidates: Array<Record<string, unknown>>;
  /** 是否为实例级标签（如球员姓名）——决定是否检查重复标签。 */
  instanceLabels: boolean;
  /** 合法 id 集合；为空集合时回退为从 candidates 自算。 */
  validIds?: ReadonlySet<string> | null;
}

/** 校验视觉映射结果。 */
export function validateVisionMappings(
  params: ValidateParams,
): ValidationResult {
  const ids =
    params.validIds && params.validIds.size > 0
      ? params.validIds
      : new Set(params.candidates.map((c) => String(c.id ?? '')));

  const nameToIdMap = nameToId(params.candidates);

  // 同 box_index 后者覆盖前者
  const byBox = new Map<number, Record<string, unknown>>();
  for (const m of params.mappings) {
    byBox.set(Number(m.box_index ?? 0), m);
  }

  const labelToBoxes = new Map<string, number[]>();
  const issues: MappingIssue[] = [];

  // ── 规则 A：无效 label_id（并跳过后续校验）────────────────────────
  const skipped = new Set<number>();
  for (const [boxIndex, m] of byBox) {
    const lid = String(m.label_id ?? '').trim();
    if (!lid) continue;
    if (!ids.has(lid)) {
      issues.push({
        boxIndex,
        code: MappingIssueCode.INVALID_LABEL_ID,
        message: `label_id=${pyRepr(lid)} 不在候选中`,
      });
      skipped.add(boxIndex);
      continue;
    }
    const list = labelToBoxes.get(lid) ?? [];
    list.push(boxIndex);
    labelToBoxes.set(lid, list);
  }

  // ── 规则 B：重复标签（仅实例标签）────────────────────────────────
  if (params.instanceLabels) {
    for (const [lid, boxIndices] of labelToBoxes) {
      if (boxIndices.length <= 1) continue;
      const name =
        params.candidates.find((c) => String(c.id ?? '') === lid)?.name ?? lid;
      for (const boxIndex of boxIndices) {
        issues.push({
          boxIndex,
          code: MappingIssueCode.DUPLICATE_LABEL,
          message: `标签 ${pyRepr(String(name))} 被分配给多个框 ${pyIntListRepr(boxIndices)}`,
        });
      }
    }
  }

  // ── 规则 C 与 D：逐框检查 ───────────────────────────────────────
  for (const [boxIndex, m] of byBox) {
    if (skipped.has(boxIndex)) continue;
    const lid = String(m.label_id ?? '').trim();
    const reason = String(m.reason ?? '');

    // 规则 C：reason 说无法确定，却给了 label_id
    if (lid && REASON_CONTRADICT_RE.test(reason)) {
      issues.push({
        boxIndex,
        code: MappingIssueCode.REASON_CONTRADICTS_LABEL,
        message: 'reason 表示无法/不匹配，但返回了非空 label_id',
      });
    }

    // 规则 D：reason 恰好提到一个候选名，且与 label_id 不符
    if (!lid || !reason) continue;
    const mentioned = findLabelNamesInText(reason, params.candidates);
    if (mentioned.length !== 1) continue;

    const mentionedName = mentioned[0].toLowerCase();
    const expectedId = nameToIdMap.get(mentionedName) ?? '';
    if (expectedId && expectedId !== lid) {
      const chosenName =
        params.candidates.find((c) => String(c.id ?? '') === lid)?.name ?? lid;
      issues.push({
        boxIndex,
        code: MappingIssueCode.REASON_NAME_MISMATCH,
        message: `reason 指向 ${pyRepr(mentioned[0])}，但 label_id 对应 ${pyRepr(String(chosenName))}`,
      });
    }
  }

  return new ValidationResult(issues);
}

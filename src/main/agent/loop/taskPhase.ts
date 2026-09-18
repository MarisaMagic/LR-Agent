/**
 * 标注任务阶段状态机。
 *
 * 移植自 `vendor/local-agent/app/agent/assist/task_phase.py`。
 *
 * 设计要点：
 *   - **运行时无状态**：每次请求由 `deriveTaskPhase` 从 `proposal_states` 重新推导
 *   - **阶段是不变量约束而非线性流程**：无标注提案历史时返回 `null`，不启用任何门禁
 *     （旧客户端与纯问答零行为变化）
 *   - **门禁分两级**：工具级（`await_confirm` 禁全部写入工具，防止「报告跑在落盘前」）
 *     与路径级（`verify` 禁对已 applied 路径重复标注）
 *
 * `scan` / `annotate` / `report` 目前**仅语义标记**，不参与拦截。
 */

export const ANNOTATION_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'auto_annotate',
  'mutate_annotation',
]);

export const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'move_workspace_file',
]);

export type TaskPhase =
  | 'scan'
  | 'annotate'
  | 'await_confirm'
  | 'verify'
  | 'report';

export interface ProposalStateLike {
  path: string;
  kind?: string;
  status?: string;
  annotationIds?: string[];
}

export interface TaskPhaseContext {
  phase: TaskPhase;
  pendingAnnotationPaths: ReadonlySet<string>;
  appliedAnnotationPaths: ReadonlySet<string>;
  appliedAnnotationIds: ReadonlySet<string>;
}

/** 门禁仅在 await_confirm / verify 启用。 */
export function gatingEnabled(ctx: TaskPhaseContext | null): boolean {
  return ctx?.phase === 'await_confirm' || ctx?.phase === 'verify';
}

/** 归一化相对路径，便于跨调用比对（统一斜杠、去 ./ 前缀）。 */
export function normalizeRelPath(path: string): string {
  let normalized = (path ?? '').trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/**
 * 从结构化提案状态推导任务阶段。
 *
 * 返回 `null` 表示不启用门禁：无 `proposal_states`（旧客户端 / 纯问答 / 无提案历史），
 * 或所有提案均为 dismissed（用户关闭提案，重新规划）。
 */
export function deriveTaskPhase(
  proposalStates: ProposalStateLike[] | null | undefined,
): TaskPhaseContext | null {
  if (!proposalStates || proposalStates.length === 0) return null;

  const pending = new Set<string>();
  const applied = new Set<string>();
  const appliedIds = new Set<string>();

  for (const state of proposalStates) {
    if (state.kind !== 'annotation') continue;
    if (state.status === 'pending') pending.add(normalizeRelPath(state.path));
    if (state.status === 'applied') {
      applied.add(normalizeRelPath(state.path));
      for (const id of state.annotationIds ?? []) {
        if (id) appliedIds.add(id);
      }
    }
  }

  if (pending.size > 0) {
    return {
      phase: 'await_confirm',
      pendingAnnotationPaths: pending,
      appliedAnnotationPaths: applied,
      appliedAnnotationIds: appliedIds,
    };
  }
  if (applied.size > 0) {
    return {
      phase: 'verify',
      pendingAnnotationPaths: new Set(),
      appliedAnnotationPaths: applied,
      appliedAnnotationIds: appliedIds,
    };
  }
  return null;
}

/**
 * 把模型传来的 list / JSON 数组字符串 / 逗号分隔 / 单值收成字符串列表。
 *
 * 部分模型会把 array 参数序列化成 `'["data/4.jpg"]'` 或 `'data/4.jpg'`，
 * 不能按 list 去迭代字符串（否则会拆成单字符）。
 */
export function coerceStrList(value: unknown): string[] {
  if (value == null) return [];
  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    let parsed: unknown = null;
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) items = parsed;
    else if (text.includes(',')) items = text.split(',');
    else items = [text];
  } else {
    items = [value];
  }
  return items
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

/** 把模型传来的 true/false（含字符串形式）收成 boolean。 */
export function coerceBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

/** 从标注工具参数中提取目标路径集合（paths 优先，兼容 scope_hint）。 */
export function extractCallPaths(arguments_: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();
  for (const item of coerceStrList(arguments_.paths)) {
    paths.add(normalizeRelPath(item));
  }
  const scopeHint = arguments_.scope_hint;
  if (typeof scopeHint === 'string') {
    for (const item of scopeHint.split(',')) {
      const text = item.trim();
      if (text) paths.add(normalizeRelPath(text));
    }
  }
  return paths;
}

/**
 * 执行前门禁。返回 `null` 表示允许；否则返回给模型的错误说明。
 *
 * 覆盖 bind 过滤之外的兜底场景。
 */
export function checkCallAllowed(
  name: string,
  arguments_: Record<string, unknown>,
  ctx: TaskPhaseContext | null,
): string | null {
  if (!gatingEnabled(ctx) || ctx === null) return null;

  if (ctx.phase === 'await_confirm') {
    if (ANNOTATION_WRITE_TOOLS.has(name) || WORKSPACE_WRITE_TOOLS.has(name)) {
      const pending = [...ctx.pendingAnnotationPaths].sort().join('、');
      return (
        `当前存在未确认的标注提案（${pending}），用户尚未 Keep All，提案未写盘。` +
        '禁止标注写入与文件写入操作。请用一两句说明提案内容，' +
        '提示用户 Keep All 或关闭提案后再继续。'
      );
    }
    return null;
  }

  if (ctx.phase === 'verify' && ANNOTATION_WRITE_TOOLS.has(name)) {
    if (ctx.appliedAnnotationPaths.size === 0) return null;
    const appliedText = [...ctx.appliedAnnotationPaths].sort().join('、');

    if (coerceBool(arguments_.all_files)) {
      return (
        `以下文件本轮已完成标注并经用户确认落盘：${appliedText}。` +
        '禁止 all_files=true 的全量重标；如确需对其他文件标注，请用 paths 明确指定。'
      );
    }

    const callPaths = extractCallPaths(arguments_);

    if (name === 'auto_annotate') {
      if (callPaths.size === 0) {
        return (
          `以下文件本轮已完成标注并经用户确认落盘：${appliedText}。` +
          'auto_annotate 未指明 paths/scope_hint，无法确认是否重复标注已落盘文件，' +
          '请用 paths 明确指定要标注的新文件。'
        );
      }
      const overlap = [...callPaths].filter((p) =>
        ctx.appliedAnnotationPaths.has(p),
      );
      if (overlap.length > 0) {
        return (
          `以下文件本轮已完成标注并经用户确认落盘：${overlap.sort().join('、')}。` +
          '请勿重复标注。如核对后认为确需重标，必须向用户说明检测到的不一致' +
          '（检测到几个框、标签是什么、与预期差在哪），' +
          '并给出确切的下一步指令（如「请说：重新标注 data/x.jpg」），由用户发起。'
        );
      }
      return null;
    }

    // mutate_annotation
    const annotationIds = coerceStrList(arguments_.annotation_ids);
    if (callPaths.size === 0 && annotationIds.length === 0) {
      return (
        `以下文件本轮已完成标注并经用户确认落盘：${appliedText}。` +
        'mutate_annotation 未指明 paths 或 annotation_ids，无法确认是否修改已落盘标注，' +
        '请明确指定目标。'
      );
    }
    // 定向修正（含已落盘文件）放行；整文件重标仍由 auto_annotate 分支拦截
    return null;
  }

  return null;
}

/** 阶段提示词块，追加到系统提示词末尾。 */
export function phasePromptBlock(ctx: TaskPhaseContext | null): string {
  if (!gatingEnabled(ctx) || ctx === null) return '';

  if (ctx.phase === 'await_confirm') {
    const paths = [...ctx.pendingAnnotationPaths].sort().join('、');
    return (
      '【任务阶段】等待用户确认标注提案\n' +
      `- 以下文件的标注提案未确认、未写盘：${paths}\n` +
      '- 禁止调用标注写入与文件写入工具；禁止声称已标注/已修改/已写入。\n' +
      '- 不要用 read_file_annotation 验证提案内容（磁盘仍是旧态，以提案台账为准）。\n' +
      '- 用一两句说明提案内容，提示用户 Keep All 或关闭提案。'
    );
  }

  if (ctx.phase === 'verify') {
    const paths = [...ctx.appliedAnnotationPaths].sort().join('、');
    return (
      '【任务阶段】标注提案已确认落盘\n' +
      `- 以下文件的标注提案已由用户 Keep All 并写盘：${paths}\n` +
      '- 可用 read_file_annotation 核对落盘结果；如任务要求报告，用 write_workspace_file 生成。\n' +
      '- 禁止对上述路径重复调用 auto_annotate 整文件重标；核对发现错标/漏标/重复框时，' +
      '用 mutate_annotation 定向修正，并带上 paths 或 annotation_ids。\n' +
      '- 提案已确认落盘，禁止再要求用户确认、Keep All 或查看提案。\n' +
      '- 报告中的每个数字必须来自工具返回或提案明细，禁止估算或凭印象填写。\n' +
      '- 工具完成后用一两句确认即可，不要重复输出报告全文。'
    );
  }

  return '';
}

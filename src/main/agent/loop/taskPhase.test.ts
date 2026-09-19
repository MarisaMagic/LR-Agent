import { describe, expect, it } from '@jest/globals';
import { checkCallAllowed, deriveTaskPhase } from './taskPhase';

/** 构造一条已应用的标注提案状态。 */
function applied(
  path: string,
  operation: string,
  extra: { inCurrentTurn?: boolean; annotationIds?: string[] } = {},
) {
  return {
    path,
    kind: 'annotation' as const,
    status: 'applied' as const,
    operation,
    inCurrentTurn: extra.inCurrentTurn ?? true,
    annotationIds: extra.annotationIds,
  };
}

describe('deriveTaskPhase：applied 门禁口径', () => {
  /**
   * 回归（用户实测的阻塞场景）：先删除再重新标注。
   *
   * 删除不产生标注，却被计入 `appliedAnnotationPaths`，于是紧接着的
   * `auto_annotate` 命中 overlap 被拦 —— 任务被自己的前置删除动作锁死。
   */
  it('仅删除（本轮）不构成「已标注」，不启用 verify 门禁', () => {
    const ctx = deriveTaskPhase([
      applied('data/1.jpg', 'delete'),
      applied('data/2.jpg', 'delete'),
      applied('data/3.jpg', 'delete'),
    ]);
    expect(ctx).toBeNull();
  });

  it('仅修改（patch）同样不构成「已标注」', () => {
    expect(deriveTaskPhase([applied('data/1.jpg', 'patch')])).toBeNull();
  });

  it('本轮的生成类操作才进入 verify 门禁', () => {
    const ctx = deriveTaskPhase([applied('data/1.jpg', 'append')]);
    expect(ctx?.phase).toBe('verify');
    expect([...(ctx?.appliedAnnotationPaths ?? [])]).toEqual(['data/1.jpg']);
  });

  it('replace / replace_bboxes 同属生成类', () => {
    const ctx = deriveTaskPhase([
      applied('data/1.jpg', 'replace'),
      applied('data/2.jpg', 'replace_bboxes'),
    ]);
    expect([...(ctx?.appliedAnnotationPaths ?? [])].sort()).toEqual([
      'data/1.jpg',
      'data/2.jpg',
    ]);
  });

  /**
   * 回归：跨轮的历史提案不得阻塞新一轮的重新标注。
   *
   * 阶段提示词让模型引导用户「重新发起请求」（如「请说：重新标注 data/x.jpg」），
   * 在全会话聚合的旧口径下那条路径根本走不通 —— 门禁不区分轮次，
   * 同一会话内任何后续重标都会被历史提案永久拦截。
   */
  it('跨轮的生成类操作不启用门禁（用户已显式重新下达指令）', () => {
    expect(
      deriveTaskPhase([
        applied('data/1.jpg', 'append', { inCurrentTurn: false }),
      ]),
    ).toBeNull();
  });

  it('本轮生成 + 跨轮生成：只按本轮判定', () => {
    const ctx = deriveTaskPhase([
      applied('data/1.jpg', 'append', { inCurrentTurn: false }),
      applied('data/2.jpg', 'append'),
    ]);
    expect([...(ctx?.appliedAnnotationPaths ?? [])]).toEqual(['data/2.jpg']);
  });

  it('跨轮的删除与本轮生成可共存', () => {
    const ctx = deriveTaskPhase([
      applied('data/1.jpg', 'delete', { inCurrentTurn: false }),
      applied('data/2.jpg', 'append'),
    ]);
    expect([...(ctx?.appliedAnnotationPaths ?? [])]).toEqual(['data/2.jpg']);
  });

  /** pending 必须保持全会话口径：未确认提案在磁盘上确实不存在。 */
  it('跨轮的 pending 仍然启用 await_confirm', () => {
    const ctx = deriveTaskPhase([
      {
        path: 'data/1.jpg',
        kind: 'annotation',
        status: 'pending',
        operation: 'append',
        inCurrentTurn: false,
      },
    ]);
    expect(ctx?.phase).toBe('await_confirm');
    expect([...(ctx?.pendingAnnotationPaths ?? [])]).toEqual(['data/1.jpg']);
  });

  it('无提案历史时不启用门禁（纯问答零行为变化）', () => {
    expect(deriveTaskPhase([])).toBeNull();
    expect(deriveTaskPhase(null)).toBeNull();
    expect(deriveTaskPhase(undefined)).toBeNull();
  });

  it('dismissed 状态不参与任何门禁', () => {
    expect(
      deriveTaskPhase([
        { path: 'data/1.jpg', kind: 'annotation', status: 'dismissed' },
      ]),
    ).toBeNull();
  });

  /** appliedAnnotationIds 保持全会话（供定向修正识别已知标注），不随轮次收窄。 */
  it('跨轮的标注 id 仍计入 appliedAnnotationIds', () => {
    const ctx = deriveTaskPhase([
      applied('data/1.jpg', 'append', {
        inCurrentTurn: false,
        annotationIds: ['a1'],
      }),
    ]);
    // 跨轮生成不进 applied 路径集合（门禁关闭）…
    expect(ctx).toBeNull();
    // …但本轮有生成时，跨轮 id 仍应可查
    const ctx2 = deriveTaskPhase([
      applied('data/1.jpg', 'append', {
        inCurrentTurn: false,
        annotationIds: ['old-1'],
      }),
      applied('data/2.jpg', 'append', { annotationIds: ['new-1'] }),
    ]);
    expect([...(ctx2?.appliedAnnotationIds ?? [])].sort()).toEqual([
      'new-1',
      'old-1',
    ]);
  });
});

describe('checkCallAllowed：verify 阶段的 auto_annotate 判定', () => {
  const verifyCtx = deriveTaskPhase([applied('data/1.jpg', 'append')])!;

  it('同路径重复标注被拦（门禁未被削弱）', () => {
    const blocked = checkCallAllowed(
      'auto_annotate',
      { paths: ['data/1.jpg'] },
      verifyCtx,
    );
    expect(blocked).toContain('请勿重复标注');
  });

  it('路径归一化后仍能命中（./ 前缀与反斜杠）', () => {
    expect(
      checkCallAllowed(
        'auto_annotate',
        { paths: ['./data\\1.jpg'] },
        verifyCtx,
      ),
    ).toContain('请勿重复标注');
  });

  it('未涉及的路径放行', () => {
    expect(
      checkCallAllowed('auto_annotate', { paths: ['data/9.jpg'] }, verifyCtx),
    ).toBeNull();
  });

  it('all_files=true 仍被拦截', () => {
    expect(
      checkCallAllowed('auto_annotate', { all_files: true }, verifyCtx),
    ).toContain('禁止 all_files=true');
  });

  it('未指明 paths 时要求明确指定', () => {
    expect(checkCallAllowed('auto_annotate', {}, verifyCtx)).toContain(
      '未指明 paths',
    );
  });

  it('mutate_annotation 的定向修正放行', () => {
    expect(
      checkCallAllowed(
        'mutate_annotation',
        { paths: ['data/1.jpg'], annotation_ids: ['a1'] },
        verifyCtx,
      ),
    ).toBeNull();
  });

  it('删除后重标：删除不产生门禁，auto_annotate 放行', () => {
    const ctx = deriveTaskPhase([applied('data/1.jpg', 'delete')]);
    expect(
      checkCallAllowed('auto_annotate', { paths: ['data/1.jpg'] }, ctx),
    ).toBeNull();
  });
});

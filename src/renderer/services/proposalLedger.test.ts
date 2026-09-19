import type { ChatMessage } from '../../shared/agentTypes';
import {
  buildProposalLedger,
  buildProposalStates,
  collectPendingAnnotationChanges,
} from './proposalLedger';

function assistantMessage(
  id: string,
  blocks: ChatMessage['blocks'],
): ChatMessage {
  return {
    id,
    sessionId: 'sess-1',
    role: 'assistant',
    blocks,
    status: 'done',
    providerId: 'p1',
    model: 'm1',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('buildProposalLedger', () => {
  it('returns empty when there are no proposals', () => {
    expect(buildProposalLedger([])).toBe('');
  });

  it('lists applied annotation paths after Keep All', () => {
    const text = buildProposalLedger([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'done',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'append',
                annotations: [
                  {
                    id: 'a',
                    kind: 'bbox',
                    labelId: 'face',
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                  {
                    id: 'b',
                    kind: 'bbox',
                    labelId: null,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                ],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(text).toContain('【已应用】');
    expect(text).toContain('已写盘');
    expect(text).toContain('data/8.jpg');
    expect(text).toContain('ids=a,b');
    expect(text).toContain('【未确认提案】无');
    expect(text).not.toContain('未写盘');
  });

  it('lists pending annotation boxes and unlabeled count', () => {
    const text = buildProposalLedger([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'pending',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: '4 boxes',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'append',
                annotations: [
                  {
                    id: 'a',
                    kind: 'bbox',
                    labelId: 'face',
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                  {
                    id: 'b',
                    kind: 'bbox',
                    labelId: null,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                ],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(text).toContain('【未确认提案】');
    expect(text).toContain('data/8.jpg');
    expect(text).toContain('ids=a,b');
    expect(text).toContain('1 个无标签');
    expect(text).toContain('【已应用】无');
  });
});

describe('collectPendingAnnotationChanges', () => {
  it('collects only pending annotation changes', () => {
    const changes = collectPendingAnnotationChanges([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'pending',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0].relativePath).toBe('data/8.jpg');
  });
});

describe('buildProposalStates', () => {
  it('returns empty when there are no proposals', () => {
    expect(buildProposalStates([])).toEqual([]);
  });

  it('collects annotation change entries with block status', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'done',
            changes: [
              {
                relativePath: 'data/2.jpg',
                absolutePath: '/p/data/2.jpg',
                operation: 'append',
                annotations: [],
              },
              {
                relativePath: 'data/4.jpg',
                absolutePath: '/p/data/4.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 2,
              succeeded: 2,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states).toEqual([
      {
        path: 'data/2.jpg',
        kind: 'annotation',
        status: 'applied',
        operation: 'append',
        annotationIds: [],
        sourceKind: 'batch',
        inCurrentTurn: true,
      },
      {
        path: 'data/4.jpg',
        kind: 'annotation',
        status: 'applied',
        operation: 'append',
        annotationIds: [],
        sourceKind: 'batch',
        inCurrentTurn: true,
      },
    ]);
  });

  it('collects file proposal entries and keeps pending status', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'file_proposal',
          status: 'pending',
          title: '报告',
          content: '# r',
          suggestedRelativePath: 'reports/r.md',
          operation: 'write',
        },
      ]),
    ]);
    expect(states).toEqual([
      {
        path: 'reports/r.md',
        kind: 'file',
        status: 'pending',
        operation: 'write',
        inCurrentTurn: true,
      },
    ]);
  });

  it('passes through dismissed and undone statuses', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'undone',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: '/p/data/8.jpg',
                operation: 'delete',
                deleteIds: ['a'],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 1,
              succeeded: 1,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states[0].status).toBe('undone');
    expect(states[0].operation).toBe('delete');
    // 单一 delete 变更 → 判定为标注编辑来源
    expect(states[0].sourceKind).toBe('mutation');
  });

  it('collects annotation ids from annotations, deleteIds and patches', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/2.jpg',
                absolutePath: '/p/data/2.jpg',
                operation: 'append',
                annotations: [
                  {
                    id: 'ann-1',
                    kind: 'bbox',
                    labelId: 'curry',
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                  {
                    id: 'ann-2',
                    kind: 'bbox',
                    labelId: null,
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    createdAt: 't',
                    updatedAt: 't',
                  },
                ],
              },
              {
                relativePath: 'data/7.jpg',
                absolutePath: '/p/data/7.jpg',
                operation: 'delete',
                deleteIds: ['ann-9'],
              },
            ],
            stats: {
              kind: 'generic',
              processed: 2,
              succeeded: 2,
              skipped: 0,
            },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states[0].annotationIds).toEqual(['ann-1', 'ann-2']);
    expect(states[1].annotationIds).toEqual(['ann-9']);
  });

  /**
   * 轮次标记：只有「最后一条 user 消息及之后」的提案算本轮。
   *
   * 门禁的 `applied` 只认本轮，否则同一会话内任何后续重新标注都会被历史提案
   * 永久拦截 —— 而阶段提示词恰恰让模型引导用户重新发起请求。
   */
  it('marks proposals before the last user message as not in current turn', () => {
    const userMessage: ChatMessage = {
      id: 'u1',
      sessionId: 'sess-1',
      role: 'user',
      blocks: [{ type: 'text', content: '重新标注' }],
      status: 'done',
      providerId: 'p1',
      model: 'm1',
      createdAt: 1,
      updatedAt: 1,
    };
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p-old',
            projectId: 'proj',
            summary: 'old',
            changes: [
              {
                relativePath: 'data/1.jpg',
                absolutePath: '/p/data/1.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
            createdAt: 1,
          },
        },
      ]),
      userMessage,
      assistantMessage('m2', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p-new',
            projectId: 'proj',
            summary: 'new',
            changes: [
              {
                relativePath: 'data/1.jpg',
                absolutePath: '/p/data/1.jpg',
                operation: 'delete',
                deleteIds: ['a'],
              },
            ],
            stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
            createdAt: 2,
          },
        },
      ]),
    ]);

    expect(states).toHaveLength(2);
    expect(states[0].inCurrentTurn).toBe(false);
    expect(states[1].inCurrentTurn).toBe(true);
  });

  it('keeps inCurrentTurn true when no user message exists', () => {
    const states = buildProposalStates([
      assistantMessage('m1', [
        {
          type: 'annotation_proposal',
          status: 'pending',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: 'x',
            changes: [
              {
                relativePath: 'data/1.jpg',
                absolutePath: '/p/data/1.jpg',
                operation: 'append',
                annotations: [],
              },
            ],
            stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
            createdAt: 1,
          },
        },
      ]),
    ]);
    expect(states[0].inCurrentTurn).toBe(true);
  });
});

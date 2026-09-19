import type { ChatMessage } from '../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import {
  annotationChangeDiffStats,
  applyAllPendingProposals,
  applyAutoApplicableProposals,
  collectMessageChangeItems,
  collectPendingChangeItems,
  collectPendingProposals,
  countPendingProposals,
  dismissPendingProposals,
  selectAutoApplicableProposals,
} from './agentProposalApply';
import { patchAgentMessageBlockRemote } from './agentChatApi';

jest.mock('./agentChatApi', () => ({
  patchAgentMessageBlockRemote: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./agentFeatureFlags', () => ({
  isAgentDocumentWriteEnabled: jest.fn(() => true),
}));

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

describe('annotationChangeDiffStats', () => {
  it('counts patches when annotations is an empty array', () => {
    expect(
      annotationChangeDiffStats({
        relativePath: 'data/8.jpg',
        absolutePath: 'C:/proj/data/8.jpg',
        operation: 'patch',
        annotations: [],
        patches: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      } as AnnotationBatchProposal['changes'][number]),
    ).toEqual({ additions: 3, deletions: 0 });
  });

  it('counts annotations for append', () => {
    expect(
      annotationChangeDiffStats({
        relativePath: 'data/8.jpg',
        absolutePath: 'C:/proj/data/8.jpg',
        operation: 'append',
        annotations: [{ id: 'a' }],
      } as AnnotationBatchProposal['changes'][number]),
    ).toEqual({ additions: 1, deletions: 0 });
  });
});

describe('collectPendingProposals', () => {
  it('collects pending proposals from multiple assistant turns', () => {
    const messages: ChatMessage[] = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'a',
          suggestedRelativePath: 'a.txt',
          status: 'pending',
        },
      ]),
      {
        ...assistantMessage('msg-2', [{ type: 'text', content: 'ok' }]),
        role: 'user',
      } as ChatMessage,
      assistantMessage('msg-3', [
        {
          type: 'file_proposal',
          title: 'B',
          content: 'b',
          suggestedRelativePath: 'b.txt',
          status: 'pending',
        },
      ]),
    ];

    const refs = collectPendingProposals(messages);
    expect(refs).toHaveLength(2);
    expect(refs[0].messageId).toBe('msg-1');
    expect(refs[1].messageId).toBe('msg-3');
  });

  it('ignores applied and undone proposals', () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'a',
          suggestedRelativePath: 'a.txt',
          status: 'applied',
        },
      ]),
      assistantMessage('msg-2', [
        {
          type: 'file_proposal',
          title: 'B',
          content: 'b',
          suggestedRelativePath: 'b.txt',
          status: 'undone',
        },
      ]),
    ];
    expect(countPendingProposals(messages)).toBe(0);
  });

  it('marks delete file proposals as destructive', () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: '删除 notes.md',
          content: '',
          suggestedRelativePath: 'notes.md',
          status: 'pending',
          operation: 'delete',
        },
      ]),
    ];
    const items = collectPendingChangeItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0].destructive).toBe(true);
    expect(items[0].operation).toBe('delete');
    expect(items[0].summary).toBe('删除文件');
  });
});

describe('collectMessageChangeItems', () => {
  it('includes applied and undone file proposals and skips dismissed', () => {
    const items = collectMessageChangeItems(
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'a',
          suggestedRelativePath: 'a.txt',
          status: 'applied',
          additions: 3,
          deletions: 1,
        },
        {
          type: 'file_proposal',
          title: 'B',
          content: '',
          suggestedRelativePath: 'b.txt',
          status: 'undone',
          operation: 'delete',
          deletions: 8,
        },
        {
          type: 'file_proposal',
          title: 'C',
          content: 'c',
          suggestedRelativePath: 'c.txt',
          status: 'dismissed',
        },
      ]),
    );
    expect(items.map((item) => item.path)).toEqual(['a.txt', 'b.txt']);
    expect(items[0]).toMatchObject({
      status: 'applied',
      additions: 3,
      deletions: 1,
    });
    expect(items[1]).toMatchObject({
      status: 'undone',
      operation: 'delete',
      deletions: 8,
    });
  });

  it('splits annotation proposals into per-file rows', () => {
    const items = collectMessageChangeItems(
      assistantMessage('msg-ann', [
        {
          type: 'annotation_proposal',
          status: 'applied',
          proposal: {
            id: 'p1',
            projectId: 'proj',
            summary: '批量',
            changes: [
              {
                relativePath: 'data/8.jpg',
                absolutePath: 'C:/proj/data/8.jpg',
                operation: 'append',
                annotations: [
                  { id: 'a1' },
                  { id: 'a2' },
                  { id: 'a3' },
                  { id: 'a4' },
                ],
              },
              {
                relativePath: 'data/9.jpg',
                absolutePath: 'C:/proj/data/9.jpg',
                operation: 'delete',
                deleteIds: ['x', 'y'],
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
          } as AnnotationBatchProposal,
        },
      ]),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      path: 'data/8.jpg',
      kind: 'annotation',
      status: 'applied',
      additions: 4,
      deletions: 0,
    });
    expect(items[1]).toMatchObject({
      path: 'data/9.jpg',
      kind: 'annotation',
      status: 'applied',
      additions: 0,
      deletions: 2,
    });
  });
});

describe('applyAllPendingProposals', () => {
  let writeTextFile: jest.Mock;
  let deleteTextFile: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    writeTextFile = jest.fn().mockResolvedValue({ success: true });
    deleteTextFile = jest.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: {
        workspace: {
          writeTextFile,
          deleteTextFile,
          readTextFile: jest.fn(),
        },
      },
    });
  });

  it('PATCHes file_proposal status after successful apply', async () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'hello',
          suggestedRelativePath: 'a.txt',
          status: 'pending',
        },
      ]),
    ];

    const updateBlock = jest.fn();

    const result = await applyAllPendingProposals({
      sessionId: 'sess-1',
      messages,
      project: null,
      workspaceRoot: '/tmp/project',
      updateBlock,
    });

    expect(result.applied).toBe(1);
    expect(updateBlock).toHaveBeenCalledWith(
      'msg-1',
      0,
      expect.objectContaining({ status: 'applied' }),
    );
    expect(patchAgentMessageBlockRemote).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      blockType: 'file_proposal',
      blockIndex: 0,
      patch: { status: 'applied', hasCheckpoint: false },
    });
  });

  it('deletes files via deleteTextFile instead of writing empty content', async () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: '删除 notes.md',
          content: '',
          suggestedRelativePath: 'notes.md',
          status: 'pending',
          operation: 'delete',
        },
      ]),
    ];

    const updateBlock = jest.fn();
    const result = await applyAllPendingProposals({
      sessionId: 'sess-1',
      messages,
      project: null,
      workspaceRoot: '/tmp/project',
      updateBlock,
    });

    expect(result.applied).toBe(1);
    expect(deleteTextFile).toHaveBeenCalledWith({
      rootDir: '/tmp/project',
      relativePath: 'notes.md',
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe('dismissPendingProposals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks pending proposals dismissed without applying', () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'hello',
          suggestedRelativePath: 'a.txt',
          status: 'pending',
        },
      ]),
    ];
    const updateBlock = jest.fn();

    const dismissed = dismissPendingProposals({
      sessionId: 'sess-1',
      messages,
      updateBlock,
    });

    expect(dismissed).toBe(1);
    expect(updateBlock).toHaveBeenCalledWith('msg-1', 0, {
      status: 'dismissed',
    });
    expect(patchAgentMessageBlockRemote).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      messageId: 'msg-1',
      blockType: 'file_proposal',
      blockIndex: 0,
      patch: { status: 'dismissed' },
    });
  });
});

/**
 * 免确认改造：只有「文件写入/删除/移动」与「标注编辑（mutation）」自动落盘，
 * 标注生成（batch）仍需用户确认。
 */
describe('selectAutoApplicableProposals', () => {
  const fileBlock = (overrides: Record<string, unknown> = {}) =>
    ({
      type: 'file_proposal',
      title: 'A',
      content: 'hello',
      suggestedRelativePath: 'a.txt',
      status: 'pending',
      contentFinalized: true,
      ...overrides,
    }) as ChatMessage['blocks'][number];

  const annotationBlock = (sourceKind?: string) =>
    ({
      type: 'annotation_proposal',
      status: 'pending',
      sourceKind,
      proposal: {
        id: 'prop-1',
        projectId: 'p1',
        summary: 's',
        changes: [
          { relativePath: 'data/1.jpg', operation: 'delete', deleteIds: ['a'] },
        ],
      },
    }) as unknown as ChatMessage['blocks'][number];

  it('选中内容已定稿的文件提案', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [fileBlock()]),
    ]);
    expect(refs).toEqual([{ messageId: 'msg-1', blockIndex: 0, kind: 'file' }]);
  });

  it('跳过尚未定稿的文件提案（避免写入空内容）', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [fileBlock({ contentFinalized: false })]),
    ]);
    expect(refs).toEqual([]);
  });

  it('跳过缺失 contentFinalized 的旧数据（保守处理）', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [fileBlock({ contentFinalized: undefined })]),
    ]);
    expect(refs).toEqual([]);
  });

  it('选中 sourceKind=mutation 的标注提案', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [annotationBlock('mutation')]),
    ]);
    expect(refs).toEqual([
      { messageId: 'msg-1', blockIndex: 0, kind: 'annotation' },
    ]);
  });

  it('跳过 sourceKind=batch 的标注提案（标注生成仍需确认）', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [annotationBlock('batch')]),
    ]);
    expect(refs).toEqual([]);
  });

  it('sourceKind 缺失时按内容推断：仅 delete/patch 视为标注编辑', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [annotationBlock(undefined)]),
    ]);
    expect(refs).toEqual([
      { messageId: 'msg-1', blockIndex: 0, kind: 'annotation' },
    ]);
  });

  it('非 pending 的提案一律跳过', () => {
    const refs = selectAutoApplicableProposals([
      assistantMessage('msg-1', [
        fileBlock({ status: 'applied' }),
        fileBlock({ status: 'dismissed' }),
      ]),
    ]);
    expect(refs).toEqual([]);
  });

  it('忽略非 assistant 消息', () => {
    const userMessage = {
      ...assistantMessage('msg-1', [fileBlock()]),
      role: 'user' as const,
    };
    expect(selectAutoApplicableProposals([userMessage])).toEqual([]);
  });

  it('isSkipped 谓词可排除已失败的提案', () => {
    const refs = selectAutoApplicableProposals(
      [assistantMessage('msg-1', [fileBlock()])],
      (ref) => ref.blockIndex === 0,
    );
    expect(refs).toEqual([]);
  });
});

describe('applyAutoApplicableProposals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('只应用免确认的子集，不触碰标注生成提案', async () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'hello',
          suggestedRelativePath: 'a.txt',
          status: 'pending',
          contentFinalized: true,
        },
        {
          type: 'annotation_proposal',
          status: 'pending',
          sourceKind: 'batch',
          proposal: {
            id: 'prop-1',
            projectId: 'p1',
            summary: 's',
            changes: [
              {
                relativePath: 'data/1.jpg',
                operation: 'append',
                annotations: [{}],
              },
            ],
          },
        },
      ] as unknown as ChatMessage['blocks']),
    ];

    const updateBlock = jest.fn();
    const result = await applyAutoApplicableProposals({
      sessionId: 'sess-1',
      messages,
      project: null,
      workspaceRoot: '/tmp/project',
      updateBlock,
    });

    expect(result.applied).toBe(1);
    // 只更新了文件提案那一条，标注生成仍保持 pending
    expect(updateBlock).toHaveBeenCalledTimes(1);
    expect(updateBlock.mock.calls[0][1]).toBe(0);
  });

  it('无可自动应用提案时不写盘', async () => {
    const messages = [
      assistantMessage('msg-1', [
        {
          type: 'annotation_proposal',
          status: 'pending',
          sourceKind: 'batch',
          proposal: {
            id: 'prop-1',
            projectId: 'p1',
            summary: 's',
            changes: [
              {
                relativePath: 'data/1.jpg',
                operation: 'append',
                annotations: [{}],
              },
            ],
          },
        },
      ] as unknown as ChatMessage['blocks']),
    ];

    const result = await applyAutoApplicableProposals({
      sessionId: 'sess-1',
      messages,
      project: null,
      workspaceRoot: '/tmp/project',
      updateBlock: jest.fn(),
    });

    expect(result).toEqual({ applied: 0, errors: [], missingCheckpoints: 0 });
  });
});

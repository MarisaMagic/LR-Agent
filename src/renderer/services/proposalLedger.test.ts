import type { ChatMessage } from '../../shared/agentTypes';
import {
  buildProposalLedger,
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

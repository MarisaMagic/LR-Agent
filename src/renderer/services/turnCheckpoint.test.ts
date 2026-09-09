import type { ChatMessage } from '../../shared/agentTypes';
import {
  collectAppliedProposalRefs,
  messageCanReapply,
  messageCanUndo,
} from './turnCheckpoint';

function assistant(
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

describe('collectAppliedProposalRefs', () => {
  it('collects applied blocks in message order for newest-first restore', () => {
    const messages = [
      assistant('msg-1', [
        {
          type: 'file_proposal',
          title: 'A',
          content: 'a',
          suggestedRelativePath: 'a.txt',
          status: 'applied',
          hasCheckpoint: true,
        },
      ]),
      assistant('msg-2', [
        {
          type: 'file_proposal',
          title: 'B',
          content: 'b',
          suggestedRelativePath: 'b.txt',
          status: 'applied',
          hasCheckpoint: true,
        },
        {
          type: 'file_proposal',
          title: 'C',
          content: 'c',
          suggestedRelativePath: 'c.txt',
          status: 'pending',
        },
      ]),
    ];
    const refs = collectAppliedProposalRefs(messages);
    expect(refs.map((item) => `${item.messageId}:${item.blockIndex}`)).toEqual([
      'msg-1:0',
      'msg-2:0',
    ]);
    expect([...refs].reverse().map((item) => item.messageId)).toEqual([
      'msg-2',
      'msg-1',
    ]);
  });

  it('skips undone and pending', () => {
    const message = assistant('msg-1', [
      {
        type: 'file_proposal',
        title: 'A',
        content: 'a',
        suggestedRelativePath: 'a.txt',
        status: 'undone',
        hasCheckpoint: true,
      },
    ]);
    expect(collectAppliedProposalRefs([message])).toEqual([]);
  });
});

describe('messageCanUndo / messageCanReapply', () => {
  it('requires checkpoint on every applied block', () => {
    expect(
      messageCanUndo(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'applied',
            hasCheckpoint: true,
          },
        ]),
      ),
    ).toBe(true);
    expect(
      messageCanUndo(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'applied',
          },
        ]),
      ),
    ).toBe(false);
  });

  it('detects undone blocks for reapply', () => {
    expect(
      messageCanReapply(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'undone',
          },
        ]),
      ),
    ).toBe(true);
    expect(
      messageCanReapply(
        assistant('msg-1', [
          {
            type: 'file_proposal',
            title: 'A',
            content: 'a',
            suggestedRelativePath: 'a.txt',
            status: 'pending',
          },
        ]),
      ),
    ).toBe(false);
  });
});

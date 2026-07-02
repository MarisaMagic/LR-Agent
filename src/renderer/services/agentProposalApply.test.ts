import type { ChatMessage } from '../../shared/agentTypes';
import {
  applyAllPendingProposals,
  collectPendingProposals,
  countPendingProposals,
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
      { ...assistantMessage('msg-2', [{ type: 'text', content: 'ok' }]), role: 'user' } as ChatMessage,
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

  it('ignores applied proposals', () => {
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
    ];
    expect(countPendingProposals(messages)).toBe(0);
  });
});

describe('applyAllPendingProposals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const writeTextFile = jest.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      writable: true,
      value: {
        workspace: {
          writeTextFile,
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
      patch: { status: 'applied' },
    });
  });
});

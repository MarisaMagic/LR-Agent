import type { MessageBlock } from '../../../shared/agentTypes';
import {
  proposalBlockSummaryLine,
  shouldHideToolCallInChat,
  shouldRenderProposalSummaryOnly,
  shouldSkipRedundantFileText,
} from './agentAssistantRenderUtils';

describe('shouldHideToolCallInChat', () => {
  it('hides write_workspace_file when file_proposal exists', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        id: 'tc-1',
        name: 'write_workspace_file',
        arguments: '{}',
        status: 'done',
        collapsed: true,
      },
      {
        type: 'file_proposal',
        title: '代码',
        content: 'int main() {}',
        suggestedRelativePath: 'main.cpp',
        status: 'pending',
      },
    ];
    const tool = blocks[0] as Extract<MessageBlock, { type: 'tool_call' }>;
    expect(shouldHideToolCallInChat(tool, blocks)).toBe(true);
  });

  it('keeps unrelated sync tools visible', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        id: 'tc-2',
        name: 'read_workspace_file',
        arguments: '{"relative_path":"a.txt"}',
        status: 'done',
        collapsed: true,
      },
    ];
    const tool = blocks[0] as Extract<MessageBlock, { type: 'tool_call' }>;
    expect(shouldHideToolCallInChat(tool, blocks)).toBe(false);
  });
});

describe('shouldSkipRedundantFileText', () => {
  it('skips text that duplicates file proposal content', () => {
    const code = '#include <bits/stdc++.h>\nint main() { return 0; }';
    const blocks: MessageBlock[] = [
      {
        type: 'file_proposal',
        title: 'main',
        content: code,
        suggestedRelativePath: 'main.cpp',
        status: 'pending',
      },
    ];
    expect(shouldSkipRedundantFileText(code, blocks)).toBe(true);
  });
});

describe('shouldRenderProposalSummaryOnly', () => {
  it('does not summary-only file proposals (inline block handles them)', () => {
    const block: MessageBlock = {
      type: 'file_proposal',
      title: 'main',
      content: 'code',
      suggestedRelativePath: 'src/main.cpp',
      status: 'pending',
    };
    expect(shouldRenderProposalSummaryOnly(block)).toBe(false);
  });

  it('does not summary-only annotation proposals', () => {
    const block: MessageBlock = {
      type: 'annotation_proposal',
      status: 'pending',
      proposal: {
        id: 'prop-1',
        projectId: 'p1',
        changes: [],
        stats: {
          processed: 0,
          succeeded: 0,
          skipped: 0,
          totalBoxes: 0,
        },
        summary: '',
        createdAt: 1,
      },
    };
    expect(shouldRenderProposalSummaryOnly(block)).toBe(false);
  });
});

describe('proposalBlockSummaryLine', () => {
  it('returns one-line summary for applied file proposal', () => {
    const block: MessageBlock = {
      type: 'file_proposal',
      title: 'main',
      content: 'code',
      suggestedRelativePath: 'src/main.cpp',
      status: 'applied',
    };
    expect(proposalBlockSummaryLine(block, 0)).toEqual({
      key: 'file-applied-0',
      text: '已写入 src/main.cpp',
    });
  });

  it('returns null for pending proposals', () => {
    const block: MessageBlock = {
      type: 'file_proposal',
      title: 'main',
      content: 'code',
      suggestedRelativePath: 'src/main.cpp',
      status: 'pending',
    };
    expect(proposalBlockSummaryLine(block, 0)).toBeNull();
  });
});

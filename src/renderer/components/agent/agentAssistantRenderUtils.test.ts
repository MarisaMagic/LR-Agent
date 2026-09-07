import type { MessageBlock } from '../../../shared/agentTypes';
import {
  shouldHideToolCallInChat,
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

import {
  applyStreamEventToBlocks,
  resolveFileProposalOperation,
  resolveFileProposalPath,
  resolveFileProposalTitle,
} from './agentChatStore';
import type { MessageBlock, StreamEvent } from '../../shared/agentTypes';

describe('resolveFileProposalPath', () => {
  it('prefers suggestedRelativePath then image_path', () => {
    expect(
      resolveFileProposalPath({
        suggestedRelativePath: 'a.md',
        image_path: 'b.md',
      }),
    ).toBe('a.md');
    expect(resolveFileProposalPath({ image_path: 'notes/readme.md' })).toBe(
      'notes/readme.md',
    );
  });
});

describe('applyStreamEventToBlocks file_proposal', () => {
  it('maps snake_case SSE fields to file_proposal block', () => {
    const fromSnake = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '# Hello',
      image_path: 'docs/readme.md',
      summary: 'Readme',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);

    expect(fromSnake).toHaveLength(1);
    expect(fromSnake[0]).toMatchObject({
      type: 'file_proposal',
      suggestedRelativePath: 'docs/readme.md',
      title: 'Readme',
      content: '# Hello',
    });
  });

  it('preserves path from prior block when final event omits path', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      title: 'Notes',
      suggestedRelativePath: 'notes/todo.md',
      detail: '0',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'body',
      image_path: 'notes/todo.md',
      summary: 'Notes',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      suggestedRelativePath: 'notes/todo.md',
      content: 'body',
    });
  });

  it('resolveFileProposalTitle uses summary fallback', () => {
    expect(resolveFileProposalTitle({ summary: 'My Doc' })).toBe('My Doc');
    expect(resolveFileProposalTitle({})).toBe('文件');
  });

  it('drops file_proposal events targeting .lr-agent', () => {
    const start = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      suggestedRelativePath: '.lr-agent/annotations/files/abc.json',
      title: 'Annotation',
      detail: '0',
    });
    expect(start).toHaveLength(0);

    const final = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '{"annotations":[]}',
      image_path: '.lr-agent/annotations/files/abc.json',
      summary: 'Annotation',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    expect(final).toHaveLength(0);
  });

  it('places file_proposal after the matching tool and keeps later text behind it', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 't-write',
      name: 'write_workspace_file',
      arguments: JSON.stringify({ relative_path: 'doc.md', content: 'hi' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'hi',
      image_path: 'doc.md',
      summary: 'Doc',
    } as unknown as StreamEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '已写好。',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'tool_call',
      'file_proposal',
      'text',
    ]);
  });
});

describe('resolveFileProposalOperation', () => {
  it('uses SSE operation or mode=delete', () => {
    expect(resolveFileProposalOperation({ operation: 'delete' })).toBe(
      'delete',
    );
    expect(resolveFileProposalOperation({ mode: 'delete' })).toBe('delete');
    expect(resolveFileProposalOperation({ mode: 'write' })).toBe('write');
  });

  it('infers delete from a matching delete_workspace_file tool', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        id: 't-del',
        name: 'delete_workspace_file',
        arguments: JSON.stringify({ relative_path: 'notes.md' }),
        status: 'done',
        collapsed: true,
      },
    ];
    expect(
      resolveFileProposalOperation(
        { image_path: 'notes.md', content: '', summary: 'notes.md' },
        blocks,
      ),
    ).toBe('delete');
  });

  it('infers delete from an empty payload titled as a deletion', () => {
    expect(
      resolveFileProposalOperation({
        summary: '删除 notes.md',
        content: '',
        image_path: 'notes.md',
      }),
    ).toBe('delete');
    expect(
      resolveFileProposalOperation({
        summary: 'delete-me.md',
        content: '',
        image_path: 'delete-me.md',
      }),
    ).toBe('write');
  });

  it('stores delete operation from SSE onto the file_proposal block', () => {
    const blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '',
      image_path: 'notes.md',
      summary: '删除 notes.md',
      mode: 'delete',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      operation: 'delete',
      suggestedRelativePath: 'notes.md',
    });
  });

  it('infers delete onto the block when a matching delete tool already exists', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 't-del',
      name: 'delete_workspace_file',
      arguments: JSON.stringify({ relative_path: 'notes.md' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: '',
      image_path: 'notes.md',
      summary: 'notes.md',
    } as unknown as StreamEvent);
    expect(blocks.map((b) => b.type)).toEqual(['tool_call', 'file_proposal']);
    expect(blocks[1]).toMatchObject({ operation: 'delete' });
  });

  it('keeps applied status and hasCheckpoint when the same file is streamed again', () => {
    let blocks: MessageBlock[] = [
      {
        type: 'file_proposal',
        title: 'Doc',
        content: 'kept',
        suggestedRelativePath: 'doc.md',
        status: 'applied',
        hasCheckpoint: true,
      },
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_start',
      title: 'Doc',
      suggestedRelativePath: 'doc.md',
      detail: '0',
    });
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      status: 'applied',
      hasCheckpoint: true,
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'newer',
      image_path: 'doc.md',
      summary: 'Doc',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      status: 'applied',
      hasCheckpoint: true,
      content: 'newer',
    });
  });
});

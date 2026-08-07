import {
  applyStreamEventToBlocks,
  resolveFileProposalPath,
  resolveFileProposalTitle,
} from './agentChatStore';

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
});

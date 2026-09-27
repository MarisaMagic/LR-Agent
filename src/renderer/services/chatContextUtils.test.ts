import { describe, expect, it } from '@jest/globals';
import { resolveSummaryOnEdit } from './chatContextUtils';
import { serializeContextSummary } from '../../shared/summarySegments';
import type { AgentSession } from '../../shared/agentTypes';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    title: 't',
    providerId: 'p1',
    model: 'm',
    messageIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const messageIds = ['u0', 'a1', 'u2', 'a3', 'u4', 'a5'];

describe('resolveSummaryOnEdit', () => {
  const session = makeSession({
    contextSummary: serializeContextSummary({
      legacyText: null,
      segments: [
        { summary: '段一', fromMessageId: '*', toMessageId: 'a1' },
        { summary: '段二', fromMessageId: 'u2', toMessageId: 'a3' },
      ],
    }),
    summaryUpToMessageId: 'a3',
  });

  it('keeps earlier segments when editing inside the second range', () => {
    const res = resolveSummaryOnEdit(session, messageIds, 'u2');
    expect(res.changed).toBe(true);
    expect(res.contextSummary).toContain('段一');
    expect(res.contextSummary).not.toContain('段二');
    expect(res.summaryUpToMessageId).toBe('a1');
  });

  it('clears all when editing inside the first range', () => {
    const res = resolveSummaryOnEdit(session, messageIds, 'a1');
    expect(res.changed).toBe(true);
    expect(res.contextSummary).toBeUndefined();
    expect(res.summaryUpToMessageId).toBeUndefined();
  });

  it('does not change when editing after all covered ranges', () => {
    const res = resolveSummaryOnEdit(session, messageIds, 'u4');
    expect(res.changed).toBe(false);
  });

  it('clears legacy summary when editing before its coverage point', () => {
    const legacy = makeSession({
      contextSummary: '旧摘要',
      summaryUpToMessageId: 'a1',
    });
    expect(resolveSummaryOnEdit(legacy, messageIds, 'u0')).toEqual({
      changed: true,
      contextSummary: undefined,
      summaryUpToMessageId: undefined,
    });
    expect(resolveSummaryOnEdit(legacy, messageIds, 'u4').changed).toBe(false);
  });

  it('does nothing when there is no summary', () => {
    expect(resolveSummaryOnEdit(makeSession(), messageIds, 'u0').changed).toBe(
      false,
    );
  });
});

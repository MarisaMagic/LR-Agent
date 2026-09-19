import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type {
  AnnotationBatchProposal,
  AnnotationProjectSnapshot,
} from '../../shared/annotationAgentTypes';
import type { StreamEvent } from '../../shared/agentTypes';
import { runAnnotationMutationJob } from './annotationAgent/mutationOrchestrator';
import type { MutationProgressEvent } from './annotationAgent/mutationOrchestrator';
import { startAnnotationMutationJob } from './annotationMutationBatchJob';
import {
  formatAnnotationToolResult,
  toolResultHasPendingProposal,
} from './agentJobRegistry';

jest.mock('./annotationAgent/mutationOrchestrator', () => ({
  runAnnotationMutationJob: jest.fn(),
}));

jest.mock('./annotationAgent/scopePathUtil', () => {
  const actual = jest.requireActual(
    './annotationAgent/scopePathUtil',
  ) as typeof import('./annotationAgent/scopePathUtil');
  return {
    ...actual,
    resolveAnnotationScopePaths: jest.fn(),
  };
});

const mockedRun = jest.mocked(runAnnotationMutationJob);

const project: AnnotationProjectSnapshot = {
  projectId: 'proj-1',
  name: 'Demo',
  directoryPath: 'C:/proj',
  modality: 'image',
  annotationType: 'bbox',
  labels: [{ id: 'l1', name: 'face', color: '#f00' }],
  detectionModels: [],
};

function buildProposal(): AnnotationBatchProposal {
  return {
    id: 'mut-1',
    projectId: 'proj-1',
    summary: '删除无标签框',
    changes: [
      {
        relativePath: 'data/8.jpg',
        absolutePath: 'C:/proj/data/8.jpg',
        operation: 'delete',
        deleteIds: ['unlabeled-1'],
      },
    ],
    stats: { kind: 'generic', processed: 1, succeeded: 1, skipped: 0 },
    createdAt: Date.now(),
  };
}

function mockPipeline(events: MutationProgressEvent[]): void {
  mockedRun.mockImplementationOnce(async function* () {
    for (const event of events) {
      yield event;
    }
  });
}

async function runJob(
  extra: Partial<Parameters<typeof startAnnotationMutationJob>[0]> = {},
) {
  const emitted: StreamEvent[] = [];
  return {
    result: await startAnnotationMutationJob({
      jobId: 'job-1',
      providerId: 'provider-1',
      userRequest: '删除没有标签的框',
      project,
      currentFileAbsolutePath: null,
      onEvent: (event) => emitted.push(event),
      signal: new AbortController().signal,
      ...extra,
    }),
    emitted,
  };
}

describe('startAnnotationMutationJob status', () => {
  afterEach(() => {
    mockedRun.mockReset();
  });

  it('returns completed with proposal', async () => {
    mockPipeline([{ type: 'proposal', proposal: buildProposal() }]);
    const { result } = await runJob();
    expect(result.status).toBe('completed');
    expect(result.hasProposal).toBe(true);
    expect(result.summary).toContain('删除无标签框');
  });

  it('returns skipped when only text is emitted without proposal', async () => {
    mockPipeline([{ type: 'text', content: '未能识别要修改或删除的标注。' }]);
    const { result } = await runJob();
    expect(result.status).toBe('skipped');
    expect(result.hasProposal).toBe(false);
    expect(result.summary).toContain('未能识别');
  });

  it('returns error on pipeline error event', async () => {
    mockPipeline([{ type: 'error', message: '变更准备失败' }]);
    const { result, emitted } = await runJob();
    expect(result.status).toBe('error');
    expect(result.hasProposal).toBe(false);
    expect(result.summary).toBe('变更准备失败');
    expect(emitted.some((event) => event.type === 'error')).toBe(false);
    expect(emitted.some((event) => event.type === 'done')).toBe(false);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'annotation_progress',
          status: 'error',
          message: '变更准备失败',
        }),
      ]),
    );
  });

  it('forwards provider credentials to the mutation orchestrator', async () => {
    mockPipeline([{ type: 'proposal', proposal: buildProposal() }]);
    await runJob({
      providerApiKey: 'sk-test',
      providerBaseUrl: 'http://localhost:11434/v1',
      providerModel: 'qwen',
    });
    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        providerApiKey: 'sk-test',
        providerBaseUrl: 'http://localhost:11434/v1',
        providerModel: 'qwen',
      }),
    );
  });
});

describe('formatAnnotationToolResult', () => {
  it('marks proposal pending and forbids claiming write', () => {
    const raw = formatAnnotationToolResult({
      status: 'completed',
      tool: 'mutate_annotation',
      userRequest: '删框',
      summary: '删除无标签框',
      hasProposal: true,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe('completed');
    expect(parsed.proposal_pending).toBe(true);
    expect(parsed.file_written).toBe(false);
    expect(String(parsed.summary)).toContain('已生成待确认提案（未写盘）');
    expect(String(parsed.summary)).not.toContain('已发送给用户确认');
  });

  it('forbids claiming delete when no proposal', () => {
    const raw = formatAnnotationToolResult({
      status: 'skipped',
      tool: 'mutate_annotation',
      userRequest: '删框',
      summary: '未能识别',
      hasProposal: false,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe('skipped');
    expect(parsed.proposal_pending).toBe(false);
    expect(String(parsed.summary)).toContain('不要对用户说已删除');
  });

  it('forbids claiming annotate complete on error', () => {
    const raw = formatAnnotationToolResult({
      status: 'error',
      tool: 'auto_annotate',
      userRequest: '标注',
      summary: '流水线失败',
      hasProposal: false,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.status).toBe('error');
    expect(String(parsed.summary)).toContain('不要对用户说已标注完成');
  });

  it('appends remaining paths when batch is truncated', () => {
    const raw = formatAnnotationToolResult({
      status: 'completed',
      tool: 'auto_annotate',
      userRequest: '全部标注',
      summary: '批量标注完成：处理 100 张。',
      hasProposal: true,
      omittedCount: 37,
      omittedPaths: ['data/101.jpg', 'data/102.jpg'],
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(String(parsed.summary)).toContain('另有 37 张因单次上限 100 未纳入');
    expect(String(parsed.summary)).toContain('data/101.jpg');
    expect(String(parsed.summary)).toContain('可再调用 auto_annotate');
  });

  // 免确认改造：标注编辑（mutate_annotation）自动落盘，不再进入确认断点
  it('reports auto-applied for annotation edits (no confirm breakpoint)', () => {
    const raw = formatAnnotationToolResult({
      status: 'completed',
      tool: 'mutate_annotation',
      userRequest: '删框',
      summary: '删除无标签框',
      hasProposal: true,
      autoApplied: true,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.proposal_pending).toBe(false);
    expect(parsed.file_written).toBe(true);
    expect(String(parsed.summary)).toContain('已生成变更并直接应用');
    // 不再出现「未写盘」这类会误导模型的说法
    expect(String(parsed.summary)).not.toContain('未写盘');
    // 关键：不得触发 AwaitingConfirm 断点
    expect(toolResultHasPendingProposal(raw)).toBe(false);
  });

  it('autoApplied 但未产出提案时仍报告未写盘', () => {
    const raw = formatAnnotationToolResult({
      status: 'skipped',
      tool: 'mutate_annotation',
      userRequest: '删框',
      summary: '未能识别',
      hasProposal: false,
      autoApplied: true,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.proposal_pending).toBe(false);
    expect(parsed.file_written).toBe(false);
    expect(String(parsed.summary)).toContain('不要对用户说已删除');
  });

  it('标注生成仍进入确认断点（autoApplied 不传）', () => {
    const raw = formatAnnotationToolResult({
      status: 'completed',
      tool: 'auto_annotate',
      userRequest: '标注',
      summary: '生成 3 个框',
      hasProposal: true,
    });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.proposal_pending).toBe(true);
    expect(toolResultHasPendingProposal(raw)).toBe(true);
  });
});

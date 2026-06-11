import { API_BASE_URL } from '../../config';
import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import type { StreamEvent } from '../../../shared/agentTypes';
import { ApiError } from '../../types/auth';
import { authFetch, parseApiError } from '../authenticatedFetch';
import tokenHolder from '../tokenHolder';
import { buildAnnotationStatsSnapshot } from './buildAnnotationStatsSnapshot';

const MAX_RUN_ATTEMPTS = 3;

export type AnalysisRepairContext = {
  previous_script: string;
  error_message: string;
  error_stage: 'syntax' | 'guard' | 'runtime';
  stdout?: string | null;
};

export type AnalysisProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
    }
  | {
      type: 'analysis_script_proposal';
      script: string;
      explanation: string;
      status: 'pending' | 'running' | 'done' | 'error';
      result?: string;
      error?: string;
    }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string };

function progress(
  stage: string,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
): AnalysisProgressEvent {
  return { type: 'progress', stage, message, status, detail };
}

function parseSseBuffer(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      const json = JSON.parse(payload) as StreamEvent;
      if (json && typeof json === 'object' && 'type' in json) {
        events.push(json);
      }
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

async function prepareAnalysisScript(
  providerId: string,
  userRequest: string,
  dataSnapshot: Record<string, unknown>,
  sessionId?: string,
  repairContext?: AnalysisRepairContext,
): Promise<{ script: string; explanation: string; attempts?: number }> {
  if (!tokenHolder.getAccessToken()) {
    throw new ApiError(401, 'not_authenticated');
  }
  const response = await authFetch(`${API_BASE_URL}/agent/analysis/prepare`, {
    method: 'POST',
    body: JSON.stringify({
      provider_id: providerId,
      user_request: userRequest,
      data_snapshot: dataSnapshot,
      session_id: sessionId ?? null,
      repair_context: repairContext ?? null,
    }),
  });
  if (!response.ok) {
    throw await parseApiError(response);
  }
  const json = (await response.json()) as {
    data: { script: string; explanation: string; attempts?: number };
  };
  return json.data;
}

export async function executeAnalysisScript(
  script: string,
  dataSnapshot: Record<string, unknown>,
): Promise<string> {
  const result = await window.electron?.analysis?.runScript({
    script,
    dataFiles: { 'annotations.json': dataSnapshot },
  });
  if (!result) {
    throw new Error('分析运行时不可用');
  }
  let out = result.stdout;
  if (result.truncated) {
    out += '\n\n（输出已截断）';
  }
  return out;
}

async function* streamAnalysisSummary(options: {
  providerId: string;
  userRequest: string;
  sessionId?: string;
  script: string;
  explanation: string;
  stdout: string;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  if (!tokenHolder.getAccessToken()) {
    throw new ApiError(401, 'not_authenticated');
  }

  const response = await authFetch(`${API_BASE_URL}/agent/analysis/summarize/stream`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream' },
    body: JSON.stringify({
      provider_id: options.providerId,
      user_request: options.userRequest,
      session_id: options.sessionId ?? null,
      script: options.script,
      explanation: options.explanation,
      stdout: options.stdout,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }
  if (!response.body) {
    throw new Error('总结流响应体为空');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === 'text_delta' && event.content) {
          yield event.content;
        }
        if (event.type === 'error') {
          throw new Error(event.message || '总结流失败');
        }
        if (event.type === 'done') {
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* runDataAnalysisJob(options: {
  providerId: string;
  userRequest: string;
  project: AnnotationProjectSnapshot;
  sessionId?: string;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}): AsyncGenerator<AnalysisProgressEvent> {
  yield progress('collect', '收集标注统计数据', 'running');
  let snapshot;
  try {
    snapshot = await buildAnnotationStatsSnapshot(options.project);
  } catch (err) {
    yield progress(
      'collect',
      '数据收集失败',
      'error',
      err instanceof Error ? err.message : undefined,
    );
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '数据收集失败',
    };
    return;
  }

  if (options.isCancelled?.()) return;

  yield progress(
    'collect',
    `已汇总 ${snapshot.totalFiles} 张图、${snapshot.totalBoxes} 个框`,
    'done',
  );

  const dataPayload = { ...snapshot, annotations: snapshot };
  let repairContext: AnalysisRepairContext | undefined;
  let prepared: { script: string; explanation: string } | null = null;
  let stdout = '';

  for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
    if (options.isCancelled?.()) return;

    const prepareLabel =
      attempt === 0 ? '生成分析脚本' : `修复脚本（第 ${attempt + 1} 次）`;
    yield progress('prepare', prepareLabel, 'running');

    try {
      prepared = await prepareAnalysisScript(
        options.providerId,
        options.userRequest,
        dataPayload,
        options.sessionId,
        repairContext,
      );
    } catch (err) {
      yield progress(
        'prepare',
        '脚本生成失败',
        'error',
        err instanceof Error ? err.message : undefined,
      );
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : '脚本生成失败',
      };
      return;
    }

    yield progress('prepare', '分析脚本已生成', 'done', prepared.explanation);
    yield {
      type: 'analysis_script_proposal',
      script: prepared.script,
      explanation: prepared.explanation,
      status: 'running',
    };

    if (options.isCancelled?.()) return;

    yield progress('execute', '运行分析脚本', 'running');
    try {
      stdout = await executeAnalysisScript(prepared.script, dataPayload);
      yield progress('execute', '脚本执行完成', 'done');
      yield {
        type: 'analysis_script_proposal',
        script: prepared.script,
        explanation: prepared.explanation,
        status: 'done',
        result: stdout,
      };
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '脚本执行失败';
      if (attempt >= MAX_RUN_ATTEMPTS - 1) {
        yield progress('execute', '脚本执行失败', 'error', msg);
        yield {
          type: 'analysis_script_proposal',
          script: prepared.script,
          explanation: prepared.explanation,
          status: 'error',
          error: msg,
        };
        yield { type: 'error', message: msg };
        return;
      }
      repairContext = {
        previous_script: prepared.script,
        error_message: msg,
        error_stage: 'runtime',
        stdout: stdout || null,
      };
      yield progress('execute', '脚本执行失败，正在修复…', 'running', msg);
    }
  }

  if (!prepared || options.isCancelled?.()) return;

  yield progress('summarize', '解读分析结果', 'running');
  try {
    let summaryStarted = false;
    for await (const delta of streamAnalysisSummary({
      providerId: options.providerId,
      userRequest: options.userRequest,
      sessionId: options.sessionId,
      script: prepared.script,
      explanation: prepared.explanation,
      stdout,
      signal: options.signal,
    })) {
      if (options.isCancelled?.()) return;
      summaryStarted = true;
      yield { type: 'text', content: delta };
    }
    yield progress(
      'summarize',
      summaryStarted ? '分析完成' : '分析完成（无总结输出）',
      'done',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : '结果解读失败';
    yield progress('summarize', '结果解读失败', 'error', msg);
    if (stdout.trim()) {
      yield {
        type: 'text',
        content: `### 原始输出\n\n\`\`\`\n${stdout.trim()}\n\`\`\`\n`,
      };
    }
    yield { type: 'error', message: msg };
  }
}

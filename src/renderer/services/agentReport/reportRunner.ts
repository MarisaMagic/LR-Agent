import { API_BASE_URL } from '../../config';
import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import type { TurnKind } from '../../../shared/agentTypes';
import { ApiError } from '../../types/auth';
import { authFetch, parseApiError } from '../authenticatedFetch';
import tokenHolder from '../tokenHolder';
import { buildAnnotationStatsSnapshot } from '../agentDataAnalysis/buildAnnotationStatsSnapshot';

export type ReportProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
    }
  | {
      type: 'document_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      summary: string;
    }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string };

function progress(
  stage: string,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
): ReportProgressEvent {
  return { type: 'progress', stage, message, status, detail };
}

function reportKindFromTurn(turnKind: TurnKind): 'report' | 'document' {
  return turnKind === 'generate_document' ? 'document' : 'report';
}

async function prepareReportMarkdown(
  providerId: string,
  userRequest: string,
  dataSnapshot: Record<string, unknown>,
  reportKind: 'report' | 'document',
  sessionId?: string,
): Promise<{
  title: string;
  content: string;
  suggested_relative_path: string;
  summary: string;
}> {
  if (!tokenHolder.getAccessToken()) {
    throw new ApiError(401, 'not_authenticated');
  }
  const response = await authFetch(`${API_BASE_URL}/agent/report/prepare`, {
    method: 'POST',
    body: JSON.stringify({
      provider_id: providerId,
      user_request: userRequest,
      data_snapshot: dataSnapshot,
      report_kind: reportKind,
      session_id: sessionId ?? null,
    }),
  });
  if (!response.ok) {
    throw await parseApiError(response);
  }
  const json = (await response.json()) as {
    data: {
      title: string;
      content: string;
      suggested_relative_path: string;
      summary: string;
    };
  };
  return json.data;
}

export async function* runReportJob(options: {
  providerId: string;
  userRequest: string;
  project: AnnotationProjectSnapshot;
  turnKind: TurnKind;
  sessionId?: string;
  isCancelled?: () => boolean;
}): AsyncGenerator<ReportProgressEvent> {
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
  yield progress('prepare', '生成 Markdown 报告', 'running');

  const reportKind = reportKindFromTurn(options.turnKind);
  try {
    const prepared = await prepareReportMarkdown(
      options.providerId,
      options.userRequest,
      { ...snapshot, annotations: snapshot },
      reportKind,
      options.sessionId,
    );
    yield progress('prepare', '报告已生成', 'done', prepared.summary);
    yield {
      type: 'document_proposal',
      title: prepared.title,
      content: prepared.content,
      suggestedRelativePath: prepared.suggested_relative_path,
      summary: prepared.summary,
    };
  } catch (err) {
    yield progress(
      'prepare',
      '报告生成失败',
      'error',
      err instanceof Error ? err.message : undefined,
    );
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '报告生成失败',
    };
  }
}

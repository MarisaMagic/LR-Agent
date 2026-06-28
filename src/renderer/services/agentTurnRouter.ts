import { API_BASE_URL } from '../config';
import type {
  ClientContextPayload,
  TaskIntent,
  TurnKind,
  TurnUnderstandingResult,
} from '../../shared/agentTypes';
import { ApiError } from '../types/auth';
import { authFetch, parseApiError } from './authenticatedFetch';
import tokenHolder from './tokenHolder';

export function buildApiClientContext(
  clientContext: ClientContextPayload,
): Record<string, unknown> {
  const snap = clientContext.annotationProjectSnapshot;
  return {
    workspace_root: clientContext.workspaceRoot ?? null,
    active_file_path: clientContext.activeFilePath ?? null,
    active_relative_path: clientContext.activeRelativePath ?? null,
    project_directory_path:
      clientContext.projectDirectoryPath ??
      snap?.directoryPath ??
      null,
    active_annotation_project_id:
      clientContext.activeAnnotationProjectId ?? null,
    annotation_project_modality:
      clientContext.annotationProjectModality ?? null,
    annotation_project_type: clientContext.annotationProjectType ?? null,
    agent_mode: clientContext.agentMode ?? null,
    work_mode: clientContext.workMode ?? null,
    selected_annotation_id: clientContext.selectedAnnotationId ?? null,
    selected_annotation_ids: clientContext.selectedAnnotationIds ?? [],
    turn_understanding: clientContext.turnUnderstanding
      ? {
          resolved_user_content:
            clientContext.turnUnderstanding.resolvedUserContent,
          referenced_relative_paths:
            clientContext.turnUnderstanding.referencedRelativePaths,
          resolved_active_relative_path:
            clientContext.turnUnderstanding.resolvedActiveRelativePath ??
            null,
          task_intent: clientContext.turnUnderstanding.taskIntent,
          turn_kind: clientContext.turnUnderstanding.turnKind,
          needs_vision_input: clientContext.turnUnderstanding.needsVisionInput,
          confidence: clientContext.turnUnderstanding.confidence,
          scope_notes: clientContext.turnUnderstanding.scopeNotes,
          reason: clientContext.turnUnderstanding.reason,
          user_visible_hint:
            clientContext.turnUnderstanding.userVisibleHint ?? null,
        }
      : null,
    annotation_project_snapshot: snap
      ? {
          project_id: snap.projectId,
          name: snap.name,
          modality: snap.modality,
          annotation_type: snap.annotationType,
          labels: snap.labels,
          detection_models: snap.detectionModels,
          project_directory_path: snap.directoryPath ?? null,
        }
      : null,
    mcp_server_url: clientContext.mcpServerUrl ?? null,
  };
}

function mapUnderstandResponse(data: {
  resolved_user_content: string;
  referenced_relative_paths?: string[];
  resolved_active_relative_path?: string | null;
  task_intent: TaskIntent;
  turn_kind: TurnKind;
  needs_vision_input: boolean;
  confidence: number;
  scope_notes: string;
  reason: string;
  user_visible_hint?: string | null;
}): TurnUnderstandingResult {
  return {
    resolvedUserContent: data.resolved_user_content,
    referencedRelativePaths: data.referenced_relative_paths ?? [],
    resolvedActiveRelativePath: data.resolved_active_relative_path ?? null,
    taskIntent: data.task_intent,
    turnKind: data.turn_kind,
    needsVisionInput: data.needs_vision_input,
    confidence: data.confidence,
    scopeNotes: data.scope_notes,
    reason: data.reason,
    userVisibleHint: data.user_visible_hint,
  };
}

/** Unified turn understanding (deixis + intent + routing) — single LLM call. */
export async function understandTurn(options: {
  providerId: string;
  userContent: string;
  clientContext: ClientContextPayload;
  sessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  truncateFromMessageId?: string | null;
  imageCatalogHint?: string[];
}): Promise<TurnUnderstandingResult> {
  if (!tokenHolder.getAccessToken()) {
    throw new ApiError(401, 'not_authenticated');
  }

  const response = await authFetch(`${API_BASE_URL}/agent/turn/understand`, {
    method: 'POST',
    body: JSON.stringify({
      provider_id: options.providerId,
      user_content: options.userContent,
      session_id: options.sessionId ?? null,
      user_message_id: options.userMessageId ?? null,
      assistant_message_id: options.assistantMessageId ?? null,
      truncate_from_message_id: options.truncateFromMessageId ?? null,
      image_catalog_hint: options.imageCatalogHint ?? null,
      client_context: buildApiClientContext(options.clientContext),
    }),
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const json = (await response.json()) as {
    data: Parameters<typeof mapUnderstandResponse>[0];
  };
  return mapUnderstandResponse(json.data);
}

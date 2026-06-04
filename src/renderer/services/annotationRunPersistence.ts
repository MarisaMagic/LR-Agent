import type { ClientContextPayload, StreamEvent } from '../../shared/agentTypes';
import { apiFetch } from './api';

const FLUSH_MS = 300;
const MAX_EVENTS_PER_BATCH = 40;

function isImmediateEvent(event: StreamEvent): boolean {
  if (event.type === 'annotation_proposal') return true;
  if (event.type === 'annotation_progress') {
    const stage = event.stage;
    if (stage === 'prepare' && event.status === 'done') return true;
    if (stage === 'workers' && event.status === 'done') return true;
  }
  if (event.type === 'text_delta') return true;
  if (event.type === 'error') return true;
  return false;
}

export class AnnotationRunPersistence {
  private buffer: StreamEvent[] = [];
  private seq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId = '';
  private assistantMessageId = '';
  private clientJobId = '';
  private userContent = '';
  private started = false;

  async start(options: {
    providerId: string;
    sessionId: string;
    clientJobId: string;
    userContent: string;
    userMessageId: string;
    assistantMessageId: string;
    truncateFromMessageId?: string | null;
    clientContext?: ClientContextPayload;
  }): Promise<void> {
    this.sessionId = options.sessionId;
    this.assistantMessageId = options.assistantMessageId;
    this.clientJobId = options.clientJobId;
    this.userContent = options.userContent;
    this.buffer = [];
    this.seq = 0;

    await apiFetch<{ session_id: string; assistant_message_id: string }>(
      '/agent/annotation-run/start',
      {
        method: 'POST',
        body: JSON.stringify({
          provider_id: options.providerId,
          session_id: options.sessionId,
          client_job_id: options.clientJobId,
          user_content: options.userContent,
          user_message_id: options.userMessageId,
          assistant_message_id: options.assistantMessageId,
          truncate_from_message_id: options.truncateFromMessageId ?? null,
          client_context: options.clientContext
            ? {
                workspace_root: options.clientContext.workspaceRoot ?? null,
                active_file_path: options.clientContext.activeFilePath ?? null,
                active_annotation_project_id:
                  options.clientContext.activeAnnotationProjectId ?? null,
                annotation_project_modality:
                  options.clientContext.annotationProjectModality ?? null,
                annotation_project_type:
                  options.clientContext.annotationProjectType ?? null,
                agent_mode: options.clientContext.agentMode ?? 'annotation',
                annotation_project_snapshot: options.clientContext.annotationProjectSnapshot
                  ? {
                      project_id: options.clientContext.annotationProjectSnapshot.projectId,
                      name: options.clientContext.annotationProjectSnapshot.name,
                      modality: options.clientContext.annotationProjectSnapshot.modality,
                      annotation_type:
                        options.clientContext.annotationProjectSnapshot.annotationType,
                      labels: options.clientContext.annotationProjectSnapshot.labels,
                      detection_models:
                        options.clientContext.annotationProjectSnapshot.detectionModels,
                    }
                  : null,
              }
            : null,
        }),
      },
    );
    this.started = true;
  }

  push(event: StreamEvent): void {
    if (!this.started) return;
    if (event.type === 'done') return;
    this.buffer.push(event);
    if (isImmediateEvent(event)) {
      void this.flush(true);
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush(false);
    }, FLUSH_MS);
  }

  async flush(force: boolean): Promise<void> {
    if (!this.started || this.buffer.length === 0) return;
    if (!force && this.buffer.length < 1) return;

    const batch = this.buffer.splice(0, MAX_EVENTS_PER_BATCH);
    this.seq += 1;
    try {
      await apiFetch<{ ok: boolean; duplicate?: boolean }>('/agent/annotation-run/events', {
        method: 'POST',
        body: JSON.stringify({
          session_id: this.sessionId,
          assistant_message_id: this.assistantMessageId,
          client_job_id: this.clientJobId,
          events: batch,
          seq: this.seq,
        }),
      });
    } catch {
      this.buffer.unshift(...batch);
      this.seq -= 1;
    }

    if (this.buffer.length > 0) {
      this.scheduleFlush();
    }
  }

  async finalize(options: {
    status: 'done' | 'error' | 'stopped';
    error?: string;
  }): Promise<void> {
    if (!this.started) return;
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush(true);
    try {
      await apiFetch<{ ok: boolean }>('/agent/annotation-run/finalize', {
        method: 'POST',
        body: JSON.stringify({
          session_id: this.sessionId,
          assistant_message_id: this.assistantMessageId,
          client_job_id: this.clientJobId,
          status: options.status,
          error: options.error ?? null,
          user_content: this.userContent,
        }),
      });
    } finally {
      this.started = false;
    }
  }
}

export async function patchAnnotationProposalStatusRemote(options: {
  sessionId: string;
  messageId: string;
  status: 'pending' | 'applied' | 'dismissed';
}): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/agent/messages/${encodeURIComponent(options.messageId)}/blocks?session_id=${encodeURIComponent(options.sessionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        block_type: 'annotation_proposal',
        patch: { status: options.status },
      }),
    },
  );
}

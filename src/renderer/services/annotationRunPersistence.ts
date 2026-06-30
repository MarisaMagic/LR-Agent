import type { ClientContextPayload, StreamEvent } from '../../shared/agentTypes';
import { apiFetch } from './api';
import { patchAgentMessageBlockRemote } from './agentChatApi';
import { buildApiClientContext } from './agentTurnRouter';

const FLUSH_MS = 300;
const MAX_EVENTS_PER_BATCH = 40;
const MAX_FLUSH_RETRIES = 5;
const BASE_RETRY_MS = 500;
const DISPOSE_TIMEOUT_MS = 12_000;

const CLIENT_PERSIST_EVENT_TYPES = new Set<string>([
  'annotation_progress',
  'annotation_proposal',
  'analysis_script_proposal',
  'file_proposal',
  'document_proposal',
]);

function isImmediateEvent(event: StreamEvent): boolean {
  if (event.type === 'annotation_proposal') return true;
  if (event.type === 'analysis_script_proposal') return true;
  if (event.type === 'file_proposal' || event.type === 'document_proposal') return true;
  if (event.type === 'annotation_progress') {
    const stage = event.stage;
    if (stage === 'prepare' && event.status === 'done') return true;
    if (stage === 'workers' && event.status === 'done') return true;
  }
  if (event.type === 'text_delta') return true;
  if (event.type === 'error') return true;
  return false;
}

export function shouldPersistClientStreamEvent(event: StreamEvent): boolean {
  if (
    event.type === 'done' ||
    event.type === 'error' ||
    event.type === 'preparing' ||
    event.type === 'route_decided' ||
    event.type === 'context_updated' ||
    event.type === 'tool_pending'
  ) {
    return false;
  }
  if (
    event.type === 'text_delta' ||
    event.type === 'reasoning_delta' ||
    event.type === 'tool_start' ||
    event.type === 'tool_result'
  ) {
    return false;
  }
  return CLIENT_PERSIST_EVENT_TYPES.has(event.type);
}

async function postEventBatch(options: {
  sessionId: string;
  assistantMessageId: string;
  clientJobId: string;
  events: StreamEvent[];
  seq: number;
}): Promise<void> {
  await apiFetch<{ ok: boolean; duplicate?: boolean }>('/agent/annotation-run/events', {
    method: 'POST',
    body: JSON.stringify({
      session_id: options.sessionId,
      assistant_message_id: options.assistantMessageId,
      client_job_id: options.clientJobId,
      events: options.events,
      seq: options.seq,
    }),
  });
}

/** 仅上报客户端工具产生的 blocks 事件（不调用 annotation-run/start）。 */
export class ChatBlockPersistence {
  private buffer: StreamEvent[] = [];
  private seq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private sessionId = '';
  private assistantMessageId = '';
  private clientJobId = '';
  private attached = false;
  private flushRetries = 0;

  attach(options: {
    sessionId: string;
    assistantMessageId: string;
    clientJobId: string;
  }): void {
    this.sessionId = options.sessionId;
    this.assistantMessageId = options.assistantMessageId;
    this.clientJobId = options.clientJobId;
    this.buffer = [];
    this.seq = 0;
    this.flushRetries = 0;
    this.attached = true;
  }

  push(event: StreamEvent): void {
    if (!this.attached) return;
    if (!shouldPersistClientStreamEvent(event)) return;
    this.buffer.push(event);
    if (isImmediateEvent(event)) {
      this.enqueueFlush(true);
      return;
    }
    this.scheduleFlush();
  }

  private enqueueFlush(force: boolean): void {
    this.flushChain = this.flushChain
      .then(() => this.flush(force))
      .catch(() => undefined);
  }

  private nextRetryDelay(): number {
    if (this.flushRetries <= 0) return FLUSH_MS;
    if (this.flushRetries >= MAX_FLUSH_RETRIES) return 10_000;
    return Math.min(BASE_RETRY_MS * Math.pow(2, this.flushRetries - 1), 10_000);
  }

  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    const delay = this.nextRetryDelay();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueFlush(false);
    }, delay);
  }

  async flush(force = false): Promise<void> {
    if (!this.attached || this.buffer.length === 0) return;
    if (!force && this.buffer.length < 1) return;

    const batch = this.buffer.splice(0, MAX_EVENTS_PER_BATCH);
    this.seq += 1;
    try {
      await postEventBatch({
        sessionId: this.sessionId,
        assistantMessageId: this.assistantMessageId,
        clientJobId: this.clientJobId,
        events: batch,
        seq: this.seq,
      });
      this.flushRetries = 0;
    } catch {
      this.buffer.unshift(...batch);
      this.seq -= 1;
      this.flushRetries += 1;
    }

    if (this.buffer.length > 0) {
      this.scheduleFlush();
    }
  }

  async dispose(): Promise<void> {
    if (!this.attached) return;
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushChain;
    this.flushRetries = 0;
    await this.flush(true);
    const deadline = Date.now() + DISPOSE_TIMEOUT_MS;
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.nextRetryDelay()));
      await this.flush(true);
    }
    this.attached = false;
  }
}

export class AnnotationRunPersistence {
  private buffer: StreamEvent[] = [];
  private seq = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
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
            ? buildApiClientContext({
                ...options.clientContext,
                agentMode: options.clientContext.agentMode ?? 'annotation',
              })
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
      this.enqueueFlush(true);
      return;
    }
    this.scheduleFlush();
  }

  private enqueueFlush(force: boolean): void {
    this.flushChain = this.flushChain
      .then(() => this.flush(force))
      .catch(() => undefined);
  }

  private scheduleFlush(): void {
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueFlush(false);
    }, FLUSH_MS);
  }

  async flush(force: boolean): Promise<void> {
    if (!this.started || this.buffer.length === 0) return;
    if (!force && this.buffer.length < 1) return;

    const batch = this.buffer.splice(0, MAX_EVENTS_PER_BATCH);
    this.seq += 1;
    try {
      await postEventBatch({
        sessionId: this.sessionId,
        assistantMessageId: this.assistantMessageId,
        clientJobId: this.clientJobId,
        events: batch,
        seq: this.seq,
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
    await this.flushChain;
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
  await patchAgentMessageBlockRemote({
    sessionId: options.sessionId,
    messageId: options.messageId,
    blockType: 'annotation_proposal',
    patch: { status: options.status },
  });
}

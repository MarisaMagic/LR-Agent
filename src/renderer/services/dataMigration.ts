import { apiFetch } from './api';

interface MigratedSession {
  id: string;
  title: string;
  annotation_project_id: string | null;
  interaction_mode: string | null;
  provider_id: string | null;
  model: string | null;
  context_summary: string | null;
  summary_up_to_message_id: string | null;
  last_context_token_estimate: number | null;
  created_at: number;
  updated_at: number;
  messages: Array<{
    id: string;
    session_id: string;
    role: string;
    interaction_mode: string | null;
    sort_index: number;
    blocks_json: string;
    status: string;
    provider_id: string | null;
    model: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
  }>;
}

interface ExportResponse {
  sessions: MigratedSession[];
  total: number;
}

function getDb() {
  return (window as unknown as { electron: { db: {
    sessions: {
      list: (opts: unknown) => Promise<{ sessions: unknown[] }>;
      create: (s: unknown) => Promise<unknown>;
      getMessageCount: (id: string) => Promise<number>;
    };
    messages: {
      batchCreate: (msgs: unknown[]) => Promise<void>;
    };
  } } }).electron.db;
}

export async function checkNeedsMigration(): Promise<boolean> {
  try {
    const db = getDb();
    // Check if any sessions exist locally
    const result = await db.sessions.list({ limit: 1, workspaceOnly: false });
    const sessions = result.sessions as unknown[];
    // Also check for annotation-project sessions
    const result2 = await db.sessions.list({ limit: 1 });
    const sessions2 = result2.sessions as unknown[];
    return sessions.length === 0 && sessions2.length === 0;
  } catch {
    return false;
  }
}

export async function migrateFromBackend(
  onProgress: (current: number, total: number) => void,
): Promise<{ migrated: number; errors: number }> {
  const db = getDb();
  let migrated = 0;
  let errors = 0;

  try {
    const data = await apiFetch<ExportResponse>('/agent/export/sessions');

    for (let i = 0; i < data.sessions.length; i++) {
      const session = data.sessions[i];
      try {
        // Create session
        await db.sessions.create({
          id: session.id,
          title: session.title,
          annotationProjectId: session.annotation_project_id,
          interactionMode: session.interaction_mode,
          providerId: session.provider_id,
          model: session.model,
        });

        // Batch create messages
        if (session.messages.length > 0) {
          await db.messages.batchCreate(
            session.messages.map((msg) => ({
              id: msg.id,
              sessionId: msg.session_id,
              role: msg.role,
              interactionMode: msg.interaction_mode ?? null,
              sortIndex: msg.sort_index,
              blocksJson: msg.blocks_json,
              status: msg.status,
              providerId: msg.provider_id ?? null,
              model: msg.model ?? null,
              error: msg.error ?? null,
              createdAt: msg.created_at,
              updatedAt: msg.updated_at,
            })),
          );
        }

        migrated++;
      } catch {
        errors++;
      }
      onProgress(i + 1, data.sessions.length);
    }

    return { migrated, errors };
  } catch (err) {
    console.error('[Migration] Failed to fetch export data:', err);
    return { migrated, errors: errors + 1 };
  }
}

export async function clearRemoteData(): Promise<boolean> {
  try {
    await apiFetch<{ status: string }>('/agent/export/clear', { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}

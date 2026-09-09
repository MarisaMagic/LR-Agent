import type { ChatMessage, MessageBlock } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import type { AnnotationProject } from '../types/annotation';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';

export type CheckpointRef = {
  sessionId: string;
  messageId: string;
  blockIndex: number;
};

type CheckpointBridge = {
  electron?: {
    checkpoint?: {
      capture?: (payload: {
        sessionId: string;
        messageId: string;
        blockIndex: number;
        kind: 'annotation' | 'file';
        projectDir?: string;
        workspaceRoot?: string;
        annotationPaths?: string[];
        filePaths?: string[];
      }) => Promise<unknown>;
      recordAfter?: (payload: {
        sessionId: string;
        messageId: string;
        blockIndex: number;
        projectDir?: string;
        workspaceRoot?: string;
      }) => Promise<unknown>;
      restore?: (payload: {
        sessionId: string;
        messageId: string;
        blockIndex: number;
        projectDir?: string;
        workspaceRoot?: string;
      }) => Promise<{
        ok: boolean;
        restoredPaths?: string[];
        error?: string;
        dirtyPaths?: string[];
      }>;
      discard?: (payload: CheckpointRef) => Promise<void>;
    };
  };
};

function getBridge() {
  return (window as Window & typeof globalThis & CheckpointBridge).electron
    ?.checkpoint;
}

export function resolveCheckpointRoots(
  project: AnnotationProject | null,
  workspaceRoot?: string | null,
): { projectDir?: string; workspaceRoot?: string } {
  return {
    projectDir: project?.directoryPath || undefined,
    workspaceRoot: workspaceRoot || project?.directoryPath || undefined,
  };
}

export async function captureProposalCheckpoint(options: {
  ref: CheckpointRef;
  kind: 'annotation' | 'file';
  project: AnnotationProject | null;
  workspaceRoot?: string | null;
  annotationPaths?: string[];
  filePaths?: string[];
}): Promise<boolean> {
  const capture = getBridge()?.capture;
  if (!capture) return false;
  try {
    await capture({
      ...options.ref,
      kind: options.kind,
      ...resolveCheckpointRoots(options.project, options.workspaceRoot),
      annotationPaths: options.annotationPaths,
      filePaths: options.filePaths,
    });
    return true;
  } catch (err) {
    console.warn('[checkpoint] capture failed', err);
    return false;
  }
}

export async function recordProposalCheckpointAfter(options: {
  ref: CheckpointRef;
  project: AnnotationProject | null;
  workspaceRoot?: string | null;
}): Promise<boolean> {
  const recordAfter = getBridge()?.recordAfter;
  if (!recordAfter) return false;
  try {
    await recordAfter({
      ...options.ref,
      ...resolveCheckpointRoots(options.project, options.workspaceRoot),
    });
    return true;
  } catch (err) {
    console.warn('[checkpoint] recordAfter failed', err);
    await discardProposalCheckpoint(options.ref);
    return false;
  }
}

export async function discardProposalCheckpoint(
  ref: CheckpointRef,
): Promise<void> {
  try {
    await getBridge()?.discard?.(ref);
  } catch {
    // ignore
  }
}

export type RestoreCheckpointsResult =
  | { ok: true; restoredPaths: string[] }
  | { ok: false; error: string; dirtyPaths?: string[] };

export function collectAppliedProposalRefs(
  messages: ChatMessage[],
  messageIds?: string[],
): Array<CheckpointRef & { kind: 'annotation' | 'file' }> {
  const allowed = messageIds ? new Set(messageIds) : null;
  const refs: Array<CheckpointRef & { kind: 'annotation' | 'file' }> = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    if (allowed && !allowed.has(msg.id)) continue;
    msg.blocks.forEach((block, blockIndex) => {
      if (block.type === 'annotation_proposal' && block.status === 'applied') {
        refs.push({
          sessionId: msg.sessionId,
          messageId: msg.id,
          blockIndex,
          kind: 'annotation',
        });
      } else if (isFileProposalBlock(block) && block.status === 'applied') {
        refs.push({
          sessionId: msg.sessionId,
          messageId: msg.id,
          blockIndex,
          kind: 'file',
        });
      }
    });
  }
  return refs;
}

export function collectUndoneProposalRefs(
  messages: ChatMessage[],
  messageId: string,
): Array<CheckpointRef & { kind: 'annotation' | 'file' }> {
  const msg = messages.find((item) => item.id === messageId);
  if (!msg || msg.role !== 'assistant') return [];
  const refs: Array<CheckpointRef & { kind: 'annotation' | 'file' }> = [];
  msg.blocks.forEach((block, blockIndex) => {
    if (block.type === 'annotation_proposal' && block.status === 'undone') {
      refs.push({
        sessionId: msg.sessionId,
        messageId: msg.id,
        blockIndex,
        kind: 'annotation',
      });
    } else if (isFileProposalBlock(block) && block.status === 'undone') {
      refs.push({
        sessionId: msg.sessionId,
        messageId: msg.id,
        blockIndex,
        kind: 'file',
      });
    }
  });
  return refs;
}

export function messageCanUndo(message: ChatMessage): boolean {
  const applied = message.blocks.filter(
    (block) =>
      (block.type === 'annotation_proposal' || isFileProposalBlock(block)) &&
      block.status === 'applied',
  );
  if (applied.length === 0) return false;
  return applied.every(
    (block) =>
      (block.type === 'annotation_proposal' || isFileProposalBlock(block)) &&
      Boolean(block.hasCheckpoint),
  );
}

export function messageCanReapply(message: ChatMessage): boolean {
  return message.blocks.some(
    (block) =>
      (block.type === 'annotation_proposal' || isFileProposalBlock(block)) &&
      block.status === 'undone',
  );
}

export function confirmDirtyWorkspaceIfNeeded(
  relativePaths: string[],
  projectId?: string | null,
): boolean {
  const snap = getAnnotationWorkspaceAgentSnapshot();
  const overlap = relativePaths.filter(
    (rel) =>
      snap.workspaceDirty &&
      snap.workspaceRelativePath === rel &&
      (!projectId || snap.workspaceProjectId === projectId),
  );
  if (overlap.length === 0) return true;
  return window.confirm('将丢弃未保存画布并回盘。是否继续？');
}

export async function restoreAppliedCheckpoints(options: {
  refs: Array<CheckpointRef>;
  project: AnnotationProject | null;
  workspaceRoot?: string | null;
  newestFirst?: boolean;
}): Promise<RestoreCheckpointsResult> {
  const restore = getBridge()?.restore;
  if (!restore) {
    return { ok: false, error: 'checkpoint_unavailable' };
  }
  const ordered = options.newestFirst
    ? [...options.refs].reverse()
    : [...options.refs];
  const restoredPaths: string[] = [];
  const roots = resolveCheckpointRoots(options.project, options.workspaceRoot);
  for (const ref of ordered) {
    const result = await restore({ ...ref, ...roots });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? 'restore_failed',
        dirtyPaths: result.dirtyPaths,
      };
    }
    restoredPaths.push(...(result.restoredPaths ?? []));
  }
  return { ok: true, restoredPaths };
}

export function formatRestoreError(result: RestoreCheckpointsResult): string {
  if (result.ok) return '';
  if (result.error === 'checkpoint_dirty') {
    const paths = result.dirtyPaths?.join('、') || '相关文件';
    return `无法回滚：以下文件已被改动：${paths}`;
  }
  if (result.error === 'checkpoint_not_found') {
    return '无法回滚：缺少改前快照';
  }
  if (result.error === 'checkpoint_incomplete') {
    return '无法回滚：快照不完整';
  }
  return result.error || '无法回滚';
}

export function annotationPathsFromBlock(block: MessageBlock): string[] {
  if (block.type !== 'annotation_proposal') return [];
  return block.proposal.changes.map((change) => change.relativePath);
}

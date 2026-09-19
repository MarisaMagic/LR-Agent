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
        force?: boolean;
      }) => Promise<{
        ok: boolean;
        restoredPaths?: string[];
        error?: string;
        dirtyPaths?: string[];
      }>;
      discard?: (payload: CheckpointRef) => Promise<void>;
      has?: (payload: CheckpointRef) => Promise<boolean>;
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
    // 不销毁快照：`afterHash` 只服务于「脏检查」，缺失它并不妨碍用
    // `beforeMissing` + blob 还原。历史上这里会 discard，导致一次 recordAfter
    // 失败就把刚捕获的改前快照删除，Undo 入口彻底消失且事后无法补救。
    console.warn('[checkpoint] recordAfter failed', err);
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
  | { ok: true; restoredPaths: string[]; skipped?: number }
  | { ok: false; error: string; dirtyPaths?: string[] };

export function blockHasCheckpoint(block: MessageBlock | undefined): boolean {
  return Boolean(
    block &&
    (block.type === 'annotation_proposal' || isFileProposalBlock(block)) &&
    block.hasCheckpoint,
  );
}

export async function probeCheckpointExists(
  ref: CheckpointRef,
): Promise<boolean> {
  const has = getBridge()?.has;
  if (!has) return false;
  try {
    return Boolean(await has(ref));
  } catch {
    return false;
  }
}

export async function partitionAppliedCheckpointRefs(
  refs: CheckpointRef[],
  getBlock: (ref: CheckpointRef) => MessageBlock | undefined,
): Promise<{ restorable: CheckpointRef[]; missing: CheckpointRef[] }> {
  const restorable: CheckpointRef[] = [];
  const missing: CheckpointRef[] = [];
  for (const ref of refs) {
    const known = blockHasCheckpoint(getBlock(ref));
    if (known || (await probeCheckpointExists(ref))) {
      restorable.push(ref);
    } else {
      missing.push(ref);
    }
  }
  return { restorable, missing };
}

export function confirmContinueWithoutSnapshot(missingCount: number): boolean {
  if (missingCount <= 0) return true;
  const detail =
    missingCount === 1
      ? '已应用的改动缺少改前快照，无法回滚，磁盘上的改动将保留。'
      : `${missingCount} 项已应用改动缺少改前快照，无法回滚，磁盘上的改动将保留。`;
  return window.confirm(`${detail}是否仍要继续？`);
}

export type EditRollbackDecision =
  | { action: 'abort' }
  | { action: 'continue'; restorable: CheckpointRef[]; skipped: number };

export async function decideEditRollback(options: {
  refs: CheckpointRef[];
  getBlock: (ref: CheckpointRef) => MessageBlock | undefined;
  confirmContinue?: (missingCount: number) => boolean;
}): Promise<EditRollbackDecision> {
  if (options.refs.length === 0) {
    return { action: 'continue', restorable: [], skipped: 0 };
  }
  const { restorable, missing } = await partitionAppliedCheckpointRefs(
    options.refs,
    options.getBlock,
  );
  if (missing.length > 0) {
    const confirm = options.confirmContinue ?? confirmContinueWithoutSnapshot;
    if (!confirm(missing.length)) {
      return { action: 'abort' };
    }
  }
  return { action: 'continue', restorable, skipped: missing.length };
}

export function isSkippableRestoreError(error: string): boolean {
  return (
    error === 'checkpoint_not_found' ||
    error === 'checkpoint_incomplete' ||
    error === 'checkpoint_unavailable'
  );
}

/**
 * 是否可通过「强制覆盖」补救的回滚失败。
 *
 * 这两类失败的共同点是：快照本身可用（`beforeMissing` + blob 齐全），
 * 失败仅来自安全校验。而安全校验的失效原因常常是**正常的后续操作**
 * （例如加载流水线修正 `filePath` 后写回、用户再次编辑），
 * 若不允许覆盖，Undo 就等于永久不可用。
 */
export function isForceRestorableError(error: string): boolean {
  return error === 'checkpoint_dirty' || error === 'checkpoint_incomplete';
}

/** 强制回滚前向用户说明代价；返回 false 表示放弃。 */
export function confirmForceRestore(result: RestoreCheckpointsResult): boolean {
  if (result.ok) return true;
  const paths = (result.dirtyPaths ?? []).filter(Boolean).join('、');
  const detail =
    result.error === 'checkpoint_dirty'
      ? `以下文件在本轮修改之后又有新的改动：${paths || '相关文件'}。强制回滚会一并丢弃这些后续改动。`
      : '改前快照缺少「改后哈希」，无法校验文件是否被改动过。强制回滚会直接按改前内容覆盖当前文件。';
  return window.confirm(`${detail}是否仍要回滚？`);
}

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
  continueOnSkippable?: boolean;
  /** 跳过「快照完整 / 未被后续改动」检查（需先获得用户确认） */
  force?: boolean;
}): Promise<RestoreCheckpointsResult> {
  const restore = getBridge()?.restore;
  if (!restore) {
    if (options.continueOnSkippable) {
      return { ok: true, restoredPaths: [], skipped: options.refs.length };
    }
    return { ok: false, error: 'checkpoint_unavailable' };
  }
  const ordered = options.newestFirst
    ? [...options.refs].reverse()
    : [...options.refs];
  const restoredPaths: string[] = [];
  let skipped = 0;
  const roots = resolveCheckpointRoots(options.project, options.workspaceRoot);
  for (const ref of ordered) {
    const result = await restore({
      ...ref,
      ...roots,
      ...(options.force ? { force: true } : {}),
    });
    if (!result.ok) {
      const error = result.error ?? 'restore_failed';
      if (options.continueOnSkippable && isSkippableRestoreError(error)) {
        skipped += 1;
        continue;
      }
      return {
        ok: false,
        error,
        dirtyPaths: result.dirtyPaths,
      };
    }
    restoredPaths.push(...(result.restoredPaths ?? []));
  }
  return { ok: true, restoredPaths, skipped };
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

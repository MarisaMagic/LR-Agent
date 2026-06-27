import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../types/annotation';
import type { ChatMessage, FileProposalLikeBlock, MessageBlock } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import { applyAnnotationBatchProposal } from './annotationProposalApply';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';
import { dispatchMutationsAppliedEvent } from './annotationProposalApply';
import { isAgentDocumentWriteEnabled } from './agentFeatureFlags';
import { buildAnnotationStatsSnapshot } from './agentDataAnalysis/buildAnnotationStatsSnapshot';
import { executeAnalysisScript } from './agentDataAnalysis/dataAnalysisRunner';
import { patchAgentMessageBlockRemote } from './agentChatApi';
import tokenHolder from './tokenHolder';

export type PendingProposalRef = {
  messageId: string;
  blockIndex: number;
  kind: 'annotation' | 'file' | 'analysis';
};

export type PendingChangeItem = {
  id: string;
  ref: PendingProposalRef;
  path: string;
  summary: string;
  kind: PendingProposalRef['kind'];
  additions?: number;
  deletions?: number;
  /** file_proposal 新内容，供 Keep All 栏异步算 diff */
  newContent?: string;
};

export function summarizeAnnotationChange(
  change: AnnotationBatchProposal['changes'][number],
): string {
  switch (change.operation) {
    case 'patch':
      return `修改 ${change.patches?.length ?? 0} 个框`;
    case 'delete':
      return `删除 ${change.deleteIds?.length ?? 0} 个框`;
    case 'replace':
    case 'replace_bboxes':
      return `替换 ${change.annotations?.length ?? 0} 个框`;
    case 'append':
    default:
      return `新增 ${change.annotations?.length ?? 0} 个框`;
  }
}

export function collectPendingChangeItems(
  messages: ChatMessage[],
): PendingChangeItem[] {
  const refs = collectPendingProposals(messages);
  const items: PendingChangeItem[] = [];

  for (const ref of refs) {
    const msg = messages.find((m) => m.id === ref.messageId);
    if (!msg) continue;
    const block = msg.blocks[ref.blockIndex];
    if (!block) continue;

    if (ref.kind === 'annotation' && block.type === 'annotation_proposal') {
      for (const change of block.proposal.changes) {
        items.push({
          id: `${ref.messageId}-${ref.blockIndex}-${change.relativePath}`,
          ref,
          path: change.relativePath,
          summary: summarizeAnnotationChange(change),
          kind: 'annotation',
        });
      }
    } else if (ref.kind === 'file' && isFileProposalBlock(block)) {
      items.push({
        id: `${ref.messageId}-${ref.blockIndex}`,
        ref,
        path: block.suggestedRelativePath,
        summary: '写入文件',
        kind: 'file',
        newContent: block.content,
      });
    } else if (
      ref.kind === 'analysis' &&
      block.type === 'analysis_script_proposal'
    ) {
      items.push({
        id: `${ref.messageId}-${ref.blockIndex}`,
        ref,
        path: '分析脚本',
        summary: '运行分析',
        kind: 'analysis',
      });
    }
  }

  return items;
}

export function collectPendingProposals(messages: ChatMessage[]): PendingProposalRef[] {
  const refs: PendingProposalRef[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    msg.blocks.forEach((block, blockIndex) => {
      if (block.type === 'annotation_proposal' && block.status === 'pending') {
        refs.push({ messageId: msg.id, blockIndex, kind: 'annotation' });
      } else if (isFileProposalBlock(block) && block.status === 'pending') {
        refs.push({ messageId: msg.id, blockIndex, kind: 'file' });
      } else if (
        block.type === 'analysis_script_proposal' &&
        block.status === 'pending'
      ) {
        refs.push({ messageId: msg.id, blockIndex, kind: 'analysis' });
      }
    });
  }
  return refs;
}

export function countPendingProposals(messages: ChatMessage[]): number {
  return collectPendingProposals(messages).length;
}

function annotationHasUnresolved(proposal: AnnotationBatchProposal): boolean {
  return proposal.changes.some((change) => {
    if (change.operation === 'patch') return !(change.patches?.length);
    if (change.operation === 'delete') return !(change.deleteIds?.length);
    if (
      change.operation === 'append' ||
      change.operation === 'replace' ||
      change.operation === 'replace_bboxes'
    ) {
      return !(change.annotations?.length);
    }
    return true;
  });
}

async function applyAnnotationBlock(
  project: AnnotationProject,
  proposal: AnnotationBatchProposal,
): Promise<void> {
  if (annotationHasUnresolved(proposal)) {
    throw new Error('标注提案包含未解析的变更');
  }
  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  const overlapPaths = proposal.changes
    .map((c) => c.relativePath)
    .filter(
      (rel) =>
        wsSnap.workspaceDirty &&
        wsSnap.workspaceRelativePath === rel &&
        wsSnap.workspaceProjectId === proposal.projectId,
    );
  if (overlapPaths.length > 0) {
    const ok = window.confirm(
      '工作区有未保存的修改，应用提案将覆盖磁盘上的标注 JSON。是否继续？',
    );
    if (!ok) throw new Error('用户取消应用');
  }
  const result = await applyAnnotationBatchProposal(project, proposal, {
    onFreshnessConflict: (_rel, reason) =>
      window.confirm(`${reason}。是否仍要应用？`),
  });
  dispatchMutationsAppliedEvent(proposal.projectId, result.relativePaths);
}

async function applyFileBlock(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
  block: FileProposalLikeBlock,
): Promise<void> {
  if (!isAgentDocumentWriteEnabled()) {
    throw new Error('文档写入功能未启用');
  }
  const root = project?.directoryPath ?? workspaceRoot;
  if (!root) throw new Error('请先打开项目或工作区目录');
  const result = await window.electron?.workspace?.writeTextFile({
    rootDir: root,
    relativePath: block.suggestedRelativePath,
    content: block.content,
  });
  if (!result?.success) {
    throw new Error(result?.error ?? '保存失败');
  }
}

async function applyAnalysisBlock(
  project: AnnotationProject,
  block: Extract<MessageBlock, { type: 'analysis_script_proposal' }>,
): Promise<string> {
  const snapshot = await buildAnnotationStatsSnapshot({
    projectId: project.id,
    name: project.name,
    directoryPath: project.directoryPath,
    modality: project.modality,
    annotationType: project.annotationType,
    labels: project.labels,
  });
  return executeAnalysisScript(block.script, {
    ...snapshot,
    annotations: snapshot,
  });
}

async function syncBlockStatusRemote(options: {
  sessionId: string;
  messageId: string;
  blockIndex: number;
  blockType: string;
  patch: Record<string, unknown>;
  onSyncWarning?: (message: string) => void;
}): Promise<void> {
  if (!tokenHolder.getAccessToken()) return;
  try {
    await patchAgentMessageBlockRemote({
      sessionId: options.sessionId,
      messageId: options.messageId,
      blockType: options.blockType,
      blockIndex: options.blockIndex,
      patch: options.patch,
    });
  } catch {
    options.onSyncWarning?.('状态未同步云端，刷新后可能再次提示 Keep All');
  }
}

export async function applyAllPendingProposals(options: {
  sessionId: string;
  messages: ChatMessage[];
  project: AnnotationProject | null;
  workspaceRoot?: string | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
  onSyncWarning?: (message: string) => void;
}): Promise<{ applied: number; errors: string[] }> {
  const refs = collectPendingProposals(options.messages);
  if (refs.length === 0) return { applied: 0, errors: [] };

  const errors: string[] = [];
  let applied = 0;

  for (const ref of refs) {
    const msg = options.messages.find((m) => m.id === ref.messageId);
    if (!msg) continue;
    const block = msg.blocks[ref.blockIndex];
    if (!block) continue;

    try {
      if (ref.kind === 'annotation' && block.type === 'annotation_proposal') {
        if (!options.project || options.project.id !== block.proposal.projectId) {
          throw new Error('请先打开对应的标注项目');
        }
        await applyAnnotationBlock(options.project, block.proposal);
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'applied',
        });
        await syncBlockStatusRemote({
          sessionId: options.sessionId,
          messageId: ref.messageId,
          blockIndex: ref.blockIndex,
          blockType: 'annotation_proposal',
          patch: { status: 'applied' },
          onSyncWarning: options.onSyncWarning,
        });
        applied += 1;
      } else if (ref.kind === 'file' && isFileProposalBlock(block)) {
        await applyFileBlock(options.project, options.workspaceRoot ?? null, block);
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'applied',
        });
        await syncBlockStatusRemote({
          sessionId: options.sessionId,
          messageId: ref.messageId,
          blockIndex: ref.blockIndex,
          blockType: 'file_proposal',
          patch: { status: 'applied' },
          onSyncWarning: options.onSyncWarning,
        });
        applied += 1;
      } else if (
        ref.kind === 'analysis' &&
        block.type === 'analysis_script_proposal'
      ) {
        if (!options.project) throw new Error('请先打开标注项目');
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'running',
        });
        const stdout = await applyAnalysisBlock(options.project, block);
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'done',
          result: stdout,
        });
        await syncBlockStatusRemote({
          sessionId: options.sessionId,
          messageId: ref.messageId,
          blockIndex: ref.blockIndex,
          blockType: 'analysis_script_proposal',
          patch: { status: 'done', result: stdout },
          onSyncWarning: options.onSyncWarning,
        });
        applied += 1;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : '应用失败');
      if (
        ref.kind === 'analysis' &&
        block.type === 'analysis_script_proposal'
      ) {
        options.updateBlock(ref.messageId, ref.blockIndex, {
          ...block,
          status: 'error',
          error: err instanceof Error ? err.message : '应用失败',
        });
      }
    }
  }

  return { applied, errors };
}

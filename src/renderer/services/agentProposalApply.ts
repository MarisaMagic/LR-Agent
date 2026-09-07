import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import type { AnnotationProject, LabelDefinition } from '../types/annotation';
import type { ChatMessage, FileProposalLikeBlock, MessageBlock } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import type { AnnotationInstance } from '../types/annotationDocument';
import { applyAnnotationBatchProposal } from './annotationProposalApply';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';
import { dispatchMutationsAppliedEvent } from './annotationProposalApply';
import { isAgentDocumentWriteEnabled } from './agentFeatureFlags';
import { patchAgentMessageBlockRemote } from './agentChatApi';

export type PendingProposalRef = {
  messageId: string;
  blockIndex: number;
  kind: 'annotation' | 'file';
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
  const kindLabel = inferAnnotationKindLabel(change);
  switch (change.operation) {
    case 'patch':
      return `修改 ${change.patches?.length ?? 0} ${kindLabel}`;
    case 'delete':
      return `删除 ${change.deleteIds?.length ?? 0} ${kindLabel}`;
    case 'replace':
    case 'replace_bboxes':
      return `替换 ${change.annotations?.length ?? 0} ${kindLabel}`;
    case 'append':
    default:
      return `新增 ${change.annotations?.length ?? 0} ${kindLabel}`;
  }
}

function inferAnnotationKindLabel(
  change: AnnotationBatchProposal['changes'][number],
): string {
  const annotations = change.annotations ?? [];
  if (annotations.length === 0) return '项';
  const kind = annotations[0].kind;
  switch (kind) {
    case 'bbox':
    case 'rotated_bbox':
    case 'polygon':
      return '个框';
    case 'caption':
      return '条描述';
    case 'classification':
      return '条分类';
    case 'instruction':
      return '条指令';
    case 'cot':
      return '条思维链';
    case 'conversation':
      return '条对话';
    case 'preference':
      return '条偏好';
    case 'span_ner':
      return '条实体';
    case 'text_classification':
      return '条分类';
    case 'pose':
    case 'point':
      return '个标注';
    default:
      return '项';
  }
}

const MAX_PREVIEW_LEN = 80;

function truncate(text: string, max: number = MAX_PREVIEW_LEN): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

function labelName(
  labelId: string | null,
  labelMap: Map<string, string>,
): string {
  if (!labelId) return '(无标签)';
  return labelMap.get(labelId) ?? labelId;
}

export function formatAnnotationPreviewText(
  ann: AnnotationInstance,
  labelMap: Map<string, string>,
): string {
  switch (ann.kind) {
    case 'bbox':
      return `${labelName(ann.labelId, labelMap)} (${ann.x.toFixed(2)}, ${ann.y.toFixed(2)}, ${ann.width.toFixed(2)}, ${ann.height.toFixed(2)})`;
    case 'rotated_bbox':
      return `${labelName(ann.labelId, labelMap)} (cx:${ann.cx.toFixed(2)}, cy:${ann.cy.toFixed(2)}, ${ann.width.toFixed(2)}x${ann.height.toFixed(2)}, ${ann.angle}deg)`;
    case 'polygon':
      return `${labelName(ann.labelId, labelMap)} (${ann.points.length} 顶点)`;
    case 'pose':
      return `${labelName(ann.labelId, labelMap)} (${ann.keypoints.length} 关键点)`;
    case 'point':
      return `${labelName(ann.labelId, labelMap)} (${ann.x.toFixed(2)}, ${ann.y.toFixed(2)})`;
    case 'caption':
      return truncate(ann.text);
    case 'classification':
      return labelName(ann.labelId, labelMap);
    case 'span_ner':
      return `${labelName(ann.labelId, labelMap)} [${ann.start}:${ann.end}]`;
    case 'text_classification':
      return `${labelName(ann.labelId, labelMap)}${ann.note ? ` (${truncate(ann.note, 40)})` : ''}`;
    case 'instruction':
      return `指令: ${truncate(ann.instruction, 30)} / 输出: ${truncate(ann.output, 30)}`;
    case 'cot':
      return `步骤: ${ann.steps.length} / 答案: ${truncate(ann.answer, 40)}`;
    case 'conversation':
      return `轮次: ${ann.turns.length} / 首: ${truncate(ann.turns[0]?.content ?? '', 30)}`;
    case 'preference':
      return `chosen: ${truncate(ann.chosen, 25)} / rejected: ${truncate(ann.rejected, 25)}`;
    default:
      return '';
  }
}

export function buildLabelMap(labels: LabelDefinition[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of labels) {
    map.set(l.id, l.name);
  }
  return map;
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

export async function applyAnnotationProposalWithGuards(
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

async function syncBlockStatusRemote(options: {
  sessionId: string;
  messageId: string;
  blockIndex: number;
  blockType: string;
  patch: Record<string, unknown>;
  onSyncWarning?: (message: string) => void;
}): Promise<void> {
  try {
    await patchAgentMessageBlockRemote({
      sessionId: options.sessionId,
      messageId: options.messageId,
      blockType: options.blockType,
      blockIndex: options.blockIndex,
      patch: options.patch,
    });
  } catch {
    options.onSyncWarning?.('状态未持久化，刷新后可能再次提示 Keep All');
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
        await applyAnnotationProposalWithGuards(options.project, block.proposal);
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
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : '应用失败');
    }
  }

  return { applied, errors };
}

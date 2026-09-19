import type { ChatMessage, ProposalStateEntry } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import { inferAnnotationProposalKind } from './annotationAgent/pipelineKinds';

function unlabeledCount(change: AnnotationBatchChange): number {
  return (change.annotations ?? []).filter((ann) => !ann.labelId).length;
}

function annotationLine(
  path: string,
  status: string,
  change: AnnotationBatchChange,
): string {
  const op = change.operation;
  const ids =
    op === 'delete'
      ? (change.deleteIds ?? [])
      : (change.annotations ?? [])
          .map((ann) => ann.id)
          .filter(Boolean)
          .slice(0, 8);
  const unlabeled = unlabeledCount(change);
  const extra = unlabeled > 0 ? `（${unlabeled} 个无标签）` : '';
  const idPart = ids.length > 0 ? ` ids=${ids.join(',')}` : '';
  return `- annotation ${status} ${path} ${op}${idPart}${extra}`;
}

function section(title: string, intro: string, lines: string[]): string[] {
  if (lines.length === 0) {
    return [`${title}无`];
  }
  return [title + intro, ...lines];
}

/** 会话提案台账。无 pending/applied 时返回空串。 */
export function buildProposalLedger(messages: ChatMessage[]): string {
  const pending: string[] = [];
  const applied: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.blocks) {
      if (block.type === 'annotation_proposal') {
        if (block.status === 'pending') {
          for (const change of block.proposal.changes) {
            pending.push(
              annotationLine(change.relativePath, 'pending', change),
            );
          }
        } else if (block.status === 'applied') {
          for (const change of block.proposal.changes) {
            applied.push(
              annotationLine(change.relativePath, 'applied', change),
            );
          }
        }
      } else if (isFileProposalBlock(block)) {
        if (block.status === 'pending') {
          pending.push(
            `- file pending ${block.suggestedRelativePath} ${block.operation ?? 'write'}`,
          );
        } else if (block.status === 'applied') {
          applied.push(
            `- file applied ${block.suggestedRelativePath} ${block.operation ?? 'write'}`,
          );
        }
      }
    }
  }
  if (pending.length === 0 && applied.length === 0) return '';
  return [
    ...section('【已应用】', '已 Keep All，已写盘。', applied),
    ...section(
      '【未确认提案】',
      '未 Keep All，未写盘。磁盘可能没有这些框，以本列表为准。',
      pending,
    ),
  ].join('\n');
}

export function collectPendingAnnotationChanges(
  messages: ChatMessage[],
): AnnotationBatchChange[] {
  const changes: AnnotationBatchChange[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of msg.blocks) {
      if (block.type === 'annotation_proposal' && block.status === 'pending') {
        changes.push(...block.proposal.changes);
      }
    }
  }
  return changes;
}

/**
 * 当前轮的起始下标：最后一条 user 消息。
 *
 * 发送请求前用户消息已写入会话，因此「最后一条 user 消息及之后」即本轮。
 * 找不到 user 消息（历史数据异常）时退回 0，等价于不过滤。
 */
function currentTurnStartIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return 0;
}

/**
 * 提案结构化状态（与 buildProposalLedger 同源），注入 client_context.proposal_states，
 * 供后端任务阶段机推导门禁。undone 透传，后端按非约束状态处理。
 *
 * 除 `path/kind/status` 外还带两个判据，用于修正门禁的两个缺陷：
 *
 *   - `sourceKind`：区分生成/编辑。删除与修改不产生标注，不应算作
 *     「该文件已标注」，否则「先删除再重新标注」会被前置删除动作拦死。
 *   - `inCurrentTurn`：`applied` 只在本轮生效。否则同一会话内**任何**后续
 *     重新标注请求都会被历史提案永久拦截 —— 而阶段提示词恰恰让模型
 *     引导用户「重新发起请求」，那条路径必须是通的。
 *
 * `pending` 仍按全会话聚合：未确认提案在磁盘上确实不存在，跨轮也必须拦住写入。
 */
export function buildProposalStates(
  messages: ChatMessage[],
): ProposalStateEntry[] {
  const states: ProposalStateEntry[] = [];
  const turnStart = currentTurnStartIndex(messages);
  messages.forEach((msg, messageIndex) => {
    if (msg.role !== 'assistant') return;
    const inCurrentTurn = messageIndex >= turnStart;
    for (const block of msg.blocks) {
      if (block.type === 'annotation_proposal') {
        const sourceKind =
          block.sourceKind ?? inferAnnotationProposalKind(block.proposal);
        for (const change of block.proposal.changes) {
          const annotationIds: string[] = [];
          if (change.annotations) {
            for (const ann of change.annotations) {
              if (ann.id) annotationIds.push(ann.id);
            }
          }
          if (change.deleteIds) {
            annotationIds.push(...change.deleteIds.filter(Boolean));
          }
          if (change.patches) {
            for (const patch of change.patches) {
              if (patch.id) annotationIds.push(patch.id);
            }
          }
          states.push({
            path: change.relativePath,
            kind: 'annotation',
            status: block.status,
            operation: change.operation,
            annotationIds,
            sourceKind,
            inCurrentTurn,
          });
        }
      } else if (isFileProposalBlock(block)) {
        states.push({
          path: block.suggestedRelativePath,
          kind: 'file',
          status: block.status,
          operation: block.operation ?? 'write',
          inCurrentTurn,
        });
      }
    }
  });
  return states;
}

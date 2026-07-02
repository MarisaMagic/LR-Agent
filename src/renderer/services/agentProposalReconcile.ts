import type { AnnotationProject } from '../types/annotation';
import type { ChatMessage, MessageBlock } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import { patchAgentMessageBlockRemote } from './agentChatApi';

function resolveWorkspaceRoot(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  return project?.directoryPath ?? workspaceRoot;
}

/** 若磁盘文件已与 pending file_proposal 一致，自动标为 applied 并持久化。 */
export async function reconcileAppliedFileProposals(options: {
  sessionId: string;
  messages: Record<string, ChatMessage>;
  messageIds: string[];
  project: AnnotationProject | null;
  workspaceRoot: string | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
}): Promise<number> {
  const root = resolveWorkspaceRoot(options.project, options.workspaceRoot);
  if (!root || !window.electron?.workspace?.readTextFile) return 0;

  let reconciled = 0;

  for (const messageId of options.messageIds) {
    const msg = options.messages[messageId];
    if (!msg || msg.role !== 'assistant') continue;

    for (let blockIndex = 0; blockIndex < msg.blocks.length; blockIndex += 1) {
      const block = msg.blocks[blockIndex];
      if (!isFileProposalBlock(block) || block.status !== 'pending') continue;

      const readResult = await window.electron.workspace.readTextFile({
        rootDir: root,
        relativePath: block.suggestedRelativePath,
      });
      if (!readResult.success) continue;
      if (!readResult.exists) continue;
      if (readResult.content !== block.content) continue;

      options.updateBlock(messageId, blockIndex, {
        ...block,
        status: 'applied',
      });
      reconciled += 1;

      // 持久化到 SQLite
      patchAgentMessageBlockRemote({
        sessionId: options.sessionId,
        messageId,
        blockType: 'file_proposal',
        blockIndex,
        patch: { status: 'applied' },
      }).catch(() => undefined);
    }
  }

  return reconciled;
}

/** 若磁盘标注文件已包含提案中的所有标注（按 id 匹配），自动标为 applied 并持久化。 */
export async function reconcileAppliedAnnotationProposals(options: {
  sessionId: string;
  messages: Record<string, ChatMessage>;
  messageIds: string[];
  project: AnnotationProject | null;
  updateBlock: (
    messageId: string,
    blockIndex: number,
    patch: Partial<MessageBlock>,
  ) => void;
}): Promise<number> {
  const projectDir = options.project?.directoryPath;
  if (!projectDir || !window.electron?.annotation?.readFileAnnotationDoc) return 0;

  let reconciled = 0;

  for (const messageId of options.messageIds) {
    const msg = options.messages[messageId];
    if (!msg || msg.role !== 'assistant') continue;

    for (let blockIndex = 0; blockIndex < msg.blocks.length; blockIndex += 1) {
      const block = msg.blocks[blockIndex];
      if (block.type !== 'annotation_proposal' || block.status !== 'pending') continue;

      let allApplied = true;
      for (const change of block.proposal.changes) {
        try {
          const raw = await window.electron.annotation.readFileAnnotationDoc(
            projectDir,
            change.relativePath,
          );
          if (!raw) {
            allApplied = false;
            break;
          }
          const existingIds = new Set(
            (raw.annotations ?? []).map((a: { id: string }) => a.id),
          );
          const proposalAnnotationIds = (change.annotations ?? [])
            .map((a) => a.id)
            .filter((id: unknown): id is string => typeof id === 'string');
          if (proposalAnnotationIds.some((id) => !existingIds.has(id))) {
            allApplied = false;
            break;
          }
        } catch {
          allApplied = false;
          break;
        }
      }

      if (!allApplied) continue;

      options.updateBlock(messageId, blockIndex, {
        ...block,
        status: 'applied',
      });
      reconciled += 1;

      // 持久化到 SQLite
      patchAgentMessageBlockRemote({
        sessionId: options.sessionId,
        messageId,
        blockType: 'annotation_proposal',
        blockIndex,
        patch: { status: 'applied' },
      }).catch(() => undefined);
    }
  }

  return reconciled;
}

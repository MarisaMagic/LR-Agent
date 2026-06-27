import type { AnnotationProject } from '../types/annotation';
import type { ChatMessage, MessageBlock } from '../../shared/agentTypes';
import { isFileProposalBlock } from '../../shared/agentTypes';
import { patchAgentMessageBlockRemote } from './agentChatApi';
import tokenHolder from './tokenHolder';

function resolveWorkspaceRoot(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  return project?.directoryPath ?? workspaceRoot;
}

/** 若磁盘文件已与 pending file_proposal 一致，自动标为 applied 并 PATCH 远端。 */
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

      if (tokenHolder.getAccessToken()) {
        try {
          await patchAgentMessageBlockRemote({
            sessionId: options.sessionId,
            messageId,
            blockType: 'file_proposal',
            blockIndex,
            patch: { status: 'applied' },
          });
        } catch {
          // 本地已 reconciled；远端失败不影响当前会话体验
        }
      }
    }
  }

  return reconciled;
}

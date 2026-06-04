/** @deprecated 批量范围请用 resolveAnnotationScope（单次 LLM JSON，见 batchOrchestrator） */
import type { ImageCandidate } from '../../../shared/annotationAgentTypes';
import { postAnnotationAgentTurn } from '../annotationAgentApi';
import type { AgentTurnMessage, AgentToolCall } from './agentTurnTypes';
import { executeScopeFsTool } from './fsToolExecutor';

const MAX_ROUNDS = 8;

export interface ScopeToolEvent {
  name: string;
  arguments: string;
  result?: string;
}

export interface ScopeAgentResult {
  selectedPaths: string[];
  reason: string;
  images: ImageCandidate[];
  toolEvents: ScopeToolEvent[];
}

export async function runScopeAgent(options: {
  providerId: string;
  userRequest: string;
  projectDir: string;
  currentRelativePath: string;
}): Promise<ScopeAgentResult> {
  const toolEvents: ScopeToolEvent[] = [];
  const knownImages = new Map<string, ImageCandidate>();
  const messages: AgentTurnMessage[] = [
    {
      role: 'human',
      content: (
        `用户请求：${options.userRequest}\n\n` +
        `当前打开文件：${options.currentRelativePath || '（无）'}\n\n` +
        '请用工具查找并确认要标注的图片相对路径。'
      ),
    },
  ];

  let selectedPaths: string[] = [];
  let reason = '';

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const turn = await postAnnotationAgentTurn(options.providerId, 'scope', messages);
    if (turn.content?.trim() && !turn.tool_calls?.length) {
      reason = reason || turn.content.trim();
    }

    if (!turn.tool_calls?.length) {
      break;
    }

    const assistantMsg: AgentTurnMessage = {
      role: 'assistant',
      content: turn.content ?? '',
      tool_calls: turn.tool_calls.map((call, idx) => ({
        ...call,
        id: call.id?.trim() || `scope-${round}-${call.name}-${idx}`,
      })),
    };
    messages.push(assistantMsg);

    for (const call of assistantMsg.tool_calls ?? []) {
      const resultText = await runScopeToolCall(
        options.projectDir,
        call,
        knownImages,
      );
      toolEvents.push({
        name: call.name,
        arguments: JSON.stringify(call.args).slice(0, 200),
        result: resultText.slice(0, 400),
      });
      messages.push({
        role: 'tool',
        content: resultText,
        tool_call_id: call.id,
      });

      if (call.name === 'select_annotation_images') {
        try {
          const payload = JSON.parse(resultText) as {
            selected_paths?: string[];
            reason?: string;
          };
          selectedPaths = payload.selected_paths ?? [];
          reason = String(payload.reason ?? reason);
        } catch {
          reason = resultText;
        }
      }
    }

    if (selectedPaths.length > 0) {
      break;
    }
  }

  if (selectedPaths.length === 0) {
    return {
      selectedPaths: [],
      reason: reason || 'Agent 未确认图片范围，请更具体说明文件夹或文件名',
      images: [],
      toolEvents,
    };
  }

  const missing = selectedPaths.filter((p) => !knownImages.has(p));
  if (missing.length > 0) {
    const agent = window.electron?.annotationAgent;
    if (agent) {
      for (const rel of missing) {
        const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const name = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
        const glob = await agent.globImages(options.projectDir, {
          parentFolder: base,
          namePattern: name,
          limit: 4,
        });
        for (const img of glob.images) {
          if (img.relativePath === rel) {
            knownImages.set(rel, {
              relativePath: img.relativePath,
              name: img.name,
              parent: img.parent,
              absolutePath: img.absolutePath,
              index: img.index,
            });
          }
        }
      }
    }
  }

  let images = selectedPaths
    .map((p) => knownImages.get(p))
    .filter((c): c is ImageCandidate => Boolean(c));

  if (images.length < selectedPaths.length) {
    const agent = window.electron?.annotationAgent;
    if (agent) {
      const catalog = await agent.listImages(options.projectDir, 600);
      for (const entry of catalog) {
        if (selectedPaths.includes(entry.relativePath)) {
          knownImages.set(entry.relativePath, {
            relativePath: entry.relativePath,
            name: entry.name,
            parent: entry.parent,
            absolutePath: entry.absolutePath,
            index: entry.index,
          });
        }
      }
      images = selectedPaths
        .map((p) => knownImages.get(p))
        .filter((c): c is ImageCandidate => Boolean(c));
    }
  }

  return { selectedPaths, reason, images, toolEvents };
}

async function runScopeToolCall(
  projectDir: string,
  call: AgentToolCall,
  knownImages: Map<string, ImageCandidate>,
): Promise<string> {
  return executeScopeFsTool(projectDir, call.name, call.args, knownImages);
}

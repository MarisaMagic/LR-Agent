/**
 * 视觉兜底加载器。
 *
 * 移植自 `vendor/local-agent/app/agent/assist/vision_bootstrap.py` 与
 * `app/agent/assist_vision.py`。
 *
 * **设计意图（不要扩权）**：历史上曾在进 LLM 前无条件预加载图片，但系统替模型选图
 * 容易看错、且浪费视觉 token。现在仅保留「弱模型首轮未调用任何工具」这一条兜底路径；
 * 正常情况由模型自行调用 `read_image_for_vision`。
 *
 * 因此触发条件是严格合取的：非 resume、provider 支持视觉、用户文本里能解析出图片路径、
 * 且仅在第 0 轮无 tool call 时尝试；一旦兜底过就置标记，避免重复注入。
 */

import { randomUUID } from 'crypto';
import { sse, type StreamEventPayload } from '../sse';
import type { ChatMessage } from '../llm/client';
import {
  buildMultimodalUserMessage,
  VISION_ATTACHMENT_TEXT,
} from '../context/multimodal';
import { IMAGE_SUFFIXES } from '../tools/fileReader';
import {
  resolveWorkspaceFile,
  type ClientContextLike,
} from '../tools/workspacePath';
import { readImageForVisionTool } from '../tools/vision';
import {
  extractVisionPath,
  formatToolResultForDisplay,
  stripInternalMarkers,
} from '../tools/result';
import type { ImageService } from '../services/imageService';
import type { AgentSettings } from '../config';

/**
 * 从用户文本中解析图片相对路径。
 *
 * 与 Python 的正则一致：路径必须出现在**行首或空白/「『之后**，避免把正文里的
 * 任意片段误判为路径。
 */
export function visionRelativeFromUserText(userContent: string): string {
  const match =
    /(?:^|[\s「『])([\w./\\-]+\.(?:jpg|jpeg|png|gif|webp|bmp|ico))\b/i.exec(
      userContent ?? '',
    );
  if (!match) return '';
  return match[1].replace(/\\/g, '/');
}

/** 自动兜底时优先使用的相对路径（当前打开的文件）。 */
export function pickVisionRelativePath(
  clientContext: ClientContextLike | null,
): string {
  const rel = (clientContext?.activeRelativePath ?? '').trim();
  return rel || '';
}

/** 该相对路径是否指向一个存在的受支持图片。 */
export function canBootstrapVision(
  clientContext: ClientContextLike | null,
  relativePath: string,
): boolean {
  const { resolved } = resolveWorkspaceFile(clientContext, relativePath);
  if (resolved === null) return false;
  const dot = resolved.lastIndexOf('.');
  const suffix = dot === -1 ? '' : resolved.slice(dot).toLowerCase();
  return IMAGE_SUFFIXES.has(suffix);
}

export interface VisionLoaderParams {
  settings: AgentSettings;
  clientContext: ClientContextLike | null;
  providerIsVision: boolean;
  userContent: string;
  imageService: ImageService;
}

export class VisionAutoLoader {
  private readonly params: VisionLoaderParams;

  constructor(params: VisionLoaderParams) {
    this.params = params;
  }

  /** 是否可能涉及图片（兜底触发前提）。 */
  shouldLoad(isResume: boolean): boolean {
    if (isResume || !this.params.providerIsVision) return false;
    return Boolean(visionRelativeFromUserText(this.params.userContent));
  }

  /**
   * 首轮无 tool call 时尝试兜底加载。
   *
   * 产出与普通视觉工具调用一致的事件序列，并在成功后追加附图。
   */
  async *tryFallback(
    messages: ChatMessage[],
  ): AsyncGenerator<StreamEventPayload> {
    let rel = pickVisionRelativePath(this.params.clientContext);
    if (!rel && this.params.userContent.trim()) {
      rel = visionRelativeFromUserText(this.params.userContent);
    }
    if (!canBootstrapVision(this.params.clientContext, rel)) return;

    // 与 Python 一致的工具 id 形态（兜底调用不对应真实的 LLM tool_call）
    const toolId = `lr-vision-fallback-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    yield* this.streamVisionToolExecution(toolId, rel, messages);
  }

  /** 执行一次视觉工具调用并产出事件（兜底路径与显式调用共用）。 */
  async *streamVisionToolExecution(
    toolId: string,
    relativePath: string,
    messages: ChatMessage[],
  ): AsyncGenerator<StreamEventPayload> {
    const args = { relative_path: relativePath };
    yield sse.toolStart(toolId, 'read_image_for_vision', args);

    let resultText: string;
    try {
      resultText = await readImageForVisionTool(
        this.params.clientContext,
        relativePath,
        {
          providerIsVision: this.params.providerIsVision,
          imageService: this.params.imageService,
        },
      );
    } catch (err) {
      resultText = `工具执行失败: ${errMessage(err)}`;
    }

    const visionPath = extractVisionPath(resultText);
    // 注意：视觉结果显示用的是「剥离内部标记后的完整缩进 JSON」，
    // **不是** formatToolResultForDisplay（那会只取 summary/message）；
    // 与 Python 的 format_vision_tool_result_for_display 对齐
    const displayResult = visionPath
      ? stripInternalMarkers(resultText)
      : resultText;

    yield sse.toolResult(toolId, displayResult);
    messages.push({
      role: 'tool',
      content: displayResult,
      toolCallId: toolId,
    });

    if (visionPath && this.params.providerIsVision) {
      messages.push(
        await buildMultimodalUserMessage(
          VISION_ATTACHMENT_TEXT,
          {
            imageAbsolutePath: visionPath,
            maxEdge: this.params.settings.chatVisionMaxEdge,
            jpegQuality: this.params.settings.chatVisionJpegQuality,
          },
          this.params.imageService,
        ),
      );
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

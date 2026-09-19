/**
 * 多模态消息构造（附图注入）。
 *
 * 移植自 `vendor/local-agent/app/agent/chat_message_builder.py`。
 *
 * 图片加载优先级与 Python 一致：**绝对路径优先**，其次 base64。
 * 编码失败或读图失败时**退化为纯文本消息**，不抛异常——避免一张坏图打断整轮对话。
 *
 * 与 Python 的差异：Python 用 `asyncio.to_thread` 把 Pillow 的同步编解码丢到线程池；
 * Node 侧编解码由主进程的 `nativeImage` 完成（经 RPC），本身不阻塞运行时事件循环，
 * 因此无需线程池。
 */

import type { ChatMessage } from '../llm/client';
import type { ImageService } from '../services/imageService';

export interface MultimodalOptions {
  imageAbsolutePath?: string;
  imageBase64?: string;
  maxEdge: number;
  jpegQuality: number;
}

/**
 * 构造带附图的用户消息。
 *
 * 无需附图（或无编码能力/编码失败）时返回纯文本消息。
 */
export async function buildMultimodalUserMessage(
  text: string,
  options: MultimodalOptions,
  imageService: ImageService,
): Promise<ChatMessage> {
  const absolutePath = (options.imageAbsolutePath ?? '').trim();
  const base64 = (options.imageBase64 ?? '').trim();
  if (!absolutePath && !base64) {
    return { role: 'user', content: text };
  }

  const encoded = await imageService.toJpegDataUrl({
    absolutePath: absolutePath || undefined,
    base64: base64 || undefined,
    maxEdge: options.maxEdge,
    quality: options.jpegQuality,
  });

  // 编码失败 / 独立模式无编码能力 → 退化为纯文本
  if (!encoded.ok || !encoded.dataUrl) {
    return { role: 'user', content: text };
  }

  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: encoded.dataUrl } },
    ],
  };
}

/** 附图注入时使用的固定提示文本（与 Python 一致）。 */
export const VISION_ATTACHMENT_TEXT =
  '【附图】请根据上图回答用户关于该图片的问题。';

/**
 * 通用 LLM 生成代理（caption / cot / instruction 等生成类标注）。
 *
 * 移植自 `vendor/local-agent/app/api/v1/annotation_agent.py` 的
 * `api_llm_generate` 与 `_build_generate_image_data_url`。
 *
 * 图片处理对齐 Python 的三条分支：
 *   1. 请求声明了图片但字节加载不到 → **抛 400 `image_load_failed`**
 *      （让前端跳过该文件，而不是静默产出无图结果）
 *   2. 路径优先、base64 兜底
 *   3. 压缩失败 → 回退发送**未压缩原图**，并保持请求声明的 MIME
 */

import fs from 'fs-extra';
import type { ChatMessage, LlmClient } from '../llm/client';
import { AnnotateHttpError } from './common';
import type { LlmGenerateRequest } from './schemas';
import type { AgentSettings } from '../config';
import type { ImageService } from '../services/imageService';

/** 从 LLM 响应内容中抽取纯文本（兼容字符串与内容块数组）。 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          return typeof record.text === 'string' ? record.text : '';
        }
        return '';
      })
      .join('');
  }
  if (content === null || content === undefined) return '';
  return String(content);
}

/**
 * 组装多模态图片 data URL。
 *
 * 见模块注释的三条分支。
 */
export async function buildGenerateImageDataUrl(
  body: LlmGenerateRequest,
  settings: AgentSettings,
  imageService: ImageService,
): Promise<string> {
  const wantsImage = Boolean(
    (body.image_absolute_path ?? '').trim() || (body.image_base64 ?? '').trim(),
  );
  if (!wantsImage) return '';

  const encoded = await imageService.toJpegDataUrl({
    absolutePath: (body.image_absolute_path ?? '').trim() || undefined,
    base64: (body.image_base64 ?? '').trim() || undefined,
    maxEdge: settings.annotationLlmImageMaxEdge,
    quality: settings.annotationLlmImageJpegQuality,
  });

  if (encoded.ok && encoded.dataUrl) return encoded.dataUrl;

  // 加载不到字节 → 400（与 Python 的 image_load_failed 对齐）
  if (isLoadFailure(encoded.error)) {
    throw new AnnotateHttpError(400, 'image_load_failed');
  }

  // 编码失败但字节可读 → 回退未压缩原图
  const raw = await loadRawBytes(body);
  if (!raw) throw new AnnotateHttpError(400, 'image_load_failed');
  return `data:${body.image_mime_type};base64,${Buffer.from(raw).toString('base64')}`;
}

/** 区分「读不到字节」（400）与「能读到但编码失败」（回退原图）。 */
function isLoadFailure(error: string | undefined): boolean {
  if (!error) return false;
  return (
    error.includes('文件不存在') ||
    error.includes('读取图片失败') ||
    error.includes('未提供图片路径') ||
    error.includes('图片数据为空') ||
    error.includes('无法识别的图片格式')
  );
}

/** 读取图片原始字节（路径优先，base64 兜底）。 */
async function loadRawBytes(body: LlmGenerateRequest): Promise<Uint8Array | null> {
  const abs = (body.image_absolute_path ?? '').trim();
  if (abs) {
    try {
      if (!(await fs.pathExists(abs))) return null;
      return await fs.readFile(abs);
    } catch {
      return null;
    }
  }
  const raw = (body.image_base64 ?? '').trim();
  if (raw) {
    const comma = raw.indexOf(',');
    const payload = raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw;
    return Uint8Array.from(Buffer.from(payload, 'base64'));
  }
  return null;
}

export interface LlmGenerateParams {
  llm: LlmClient;
  body: LlmGenerateRequest;
  settings: AgentSettings;
  imageService: ImageService;
  signal?: AbortSignal;
}

/**
 * 执行一次生成类调用，返回纯文本结果。
 *
 * 非流式（与 Python 的 `ainvoke` 一致）——生成类 pipeline 是一次性拿完整结果再本地解析。
 */
export async function llmGenerate(params: LlmGenerateParams): Promise<string> {
  const { body } = params;

  const messages: ChatMessage[] = [];
  if (body.system_prompt.trim()) {
    messages.push({ role: 'system', content: body.system_prompt });
  }

  const imageDataUrl = await buildGenerateImageDataUrl(
    body,
    params.settings,
    params.imageService,
  );

  if (imageDataUrl) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: body.user_prompt ?? '' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: body.user_prompt ?? '' });
  }

  const turn = await params.llm.completeChat({
    messages,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    signal: params.signal,
  });

  return contentToText(turn.content);
}

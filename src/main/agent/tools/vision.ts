/**
 * `read_image_for_vision`：加载图片元信息并标记待注入附图。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/workspace_file_reader.py` 的
 * `read_image_for_vision_tool`。
 *
 * 结果为 JSON，其中含**内部标记** `__vision_image_path__`：调度层据此提取图片绝对路径，
 * 剥离标记后把结果发给前端，并在对应 `ToolMessage` 之后追加一条多模态 `HumanMessage`
 * （附图注入，阶段 5 接入）。
 *
 * 与 Python 的差异：Python 用 Pillow 读尺寸，这里用文件头解析（纯函数、可在独立模式
 * 运行），文件头无法识别时才经 RPC 让主进程用 `nativeImage` 兜底。
 */

import path from 'path';
import { buildToolResult, VISION_PATH_MARKER } from './result';
import {
  resolveWorkspaceFile,
  type ClientContextLike,
} from './workspacePath';
import { IMAGE_SUFFIXES } from './fileReader';
import type { ImageService } from '../services/imageService';

/** 与 Python 一致的格式清单（用于错误文案）。 */
const SUFFIX_LIST = [...IMAGE_SUFFIXES].sort().join(', ');

export async function readImageForVisionTool(
  clientContext: ClientContextLike | null,
  relativePath: string,
  options: { providerIsVision: boolean; imageService: ImageService },
): Promise<string> {
  if (!options.providerIsVision) {
    return (
      '当前大模型未通过视觉能力探针，无法分析图片内容。' +
      '请在「大模型配置」中选用支持视觉的模型并重探视觉能力。'
    );
  }

  const { resolved, error } = resolveWorkspaceFile(clientContext, relativePath);
  if (resolved === null) return error;

  const fileName = path.basename(resolved);
  const suffix = path.extname(resolved).toLowerCase();
  if (!IMAGE_SUFFIXES.has(suffix)) {
    return `「${fileName}」不是支持的图片格式（${SUFFIX_LIST}）。`;
  }

  const probed = await options.imageService.probe({ absolutePath: resolved });
  if (!probed.ok || probed.width == null || probed.height == null) {
    return `无法打开图片：${probed.error ?? '未知错误'}`;
  }

  const format = probed.format ?? suffix.replace('.', '').toUpperCase();
  return JSON.stringify({
    ok: true,
    path: resolved,
    name: fileName,
    width: probed.width,
    height: probed.height,
    format,
    [VISION_PATH_MARKER]: resolved,
    message:
      `已加载图片 ${fileName}（${probed.width}x${probed.height} ${format}）。` +
      '系统将在本条工具结果后注入附图，请根据图像回答用户问题。',
  });
}

/** 供调度层复用的失败结果构造。 */
export function visionFailure(summary: string): string {
  return buildToolResult({
    ok: false,
    tool: 'read_image_for_vision',
    status: 'error',
    summary,
  });
}

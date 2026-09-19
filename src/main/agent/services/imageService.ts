/**
 * 图像服务：把「纯可计算的探测」与「依赖 Electron 的编解码」分层。
 *
 * 分层理由：
 *   - **尺寸/格式探测**用文件头解析即可，是纯函数——两种运行模式（utilityProcess
 *     与独立 `node runtime.js`）都能用，且语义与 Pillow 的惰性 `Image.open().size`
 *     更接近（读文件头、不解码、不应用 EXIF 旋转）。
 *   - **缩放/裁剪/JPEG 编码**必须用 Electron 的 `nativeImage`（utilityProcess 内不可用），
 *     因此经 RPC 走主进程；独立模式下不可用，返回明确的降级错误。
 *
 * 这样在独立模式下依然能跑通 golden diff 的 `single-tool` 等场景，
 * 而需要真正编码图片的场景（附图注入、逐框裁剪）只在 Electron 内生效。
 */

import fs from 'fs-extra';
import type { Bridge } from '../bridge';
import { AGENT_CHANNELS } from '../protocol';
import {
  fitWithinMaxEdge,
  mimeFromSuffix,
  parseImageHeader,
  toDataUrl,
} from '../../agentImage/imageOps';

export interface ImageProbeParams {
  absolutePath?: string;
  base64?: string;
}

export interface ImageProbeResult {
  ok: boolean;
  width?: number;
  height?: number;
  format?: string;
  error?: string;
}

export interface ImageDataUrlParams {
  absolutePath?: string;
  base64?: string;
  maxEdge: number;
  quality: number;
}

export interface ImageDataUrlResult {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  format?: string;
  error?: string;
}

export interface CropBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CropBatchParams {
  absolutePath?: string;
  base64?: string;
  boxes: CropBox[];
  maxEdge: number;
  quality: number;
}

export interface CropBatchResult {
  ok: boolean;
  images?: string[];
  error?: string;
}

export interface ImageService {
  probe(params: ImageProbeParams): Promise<ImageProbeResult>;
  toJpegDataUrl(params: ImageDataUrlParams): Promise<ImageDataUrlResult>;
  cropBatch(params: CropBatchParams): Promise<CropBatchResult>;
  /** 是否具备编码能力（即运行在 Electron 内）。 */
  readonly canEncode: boolean;
}

/** 读取图片字节：绝对路径优先，其次 base64。 */
function loadBytes(params: { absolutePath?: string; base64?: string }): {
  bytes: Buffer;
  error?: string;
} {
  const abs = (params.absolutePath ?? '').trim();
  if (abs) {
    try {
      if (!fs.existsSync(abs)) {
        return { bytes: Buffer.alloc(0), error: `文件不存在：${abs}` };
      }
      return { bytes: fs.readFileSync(abs) };
    } catch (err) {
      return {
        bytes: Buffer.alloc(0),
        error: `读取图片失败：${errMessage(err)}`,
      };
    }
  }
  const raw = (params.base64 ?? '').trim();
  if (raw) {
    const comma = raw.indexOf(',');
    const payload =
      raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw;
    return { bytes: Buffer.from(payload, 'base64') };
  }
  return { bytes: Buffer.alloc(0), error: '未提供图片路径或 base64 数据。' };
}

/** 纯文件头探测（不解码）。 */
export function probeByHeader(params: ImageProbeParams): ImageProbeResult {
  const loaded = loadBytes(params);
  if (loaded.error) return { ok: false, error: loaded.error };
  if (loaded.bytes.length === 0) return { ok: false, error: '图片数据为空。' };

  const header = parseImageHeader(loaded.bytes);
  if (!header) return { ok: false, error: '无法识别的图片格式。' };
  return {
    ok: true,
    width: header.width,
    height: header.height,
    format: header.format,
  };
}

/**
 * 构造图像服务。
 *
 * @param bridge RPC 桥；独立模式下传 null（此时只有探测能力可用）
 */
export function createImageService(bridge: Bridge | null): ImageService {
  const unavailable = (): { ok: false; error: string } => ({
    ok: false,
    error:
      '图像编码需要在 Electron 环境中运行（当前为独立模式，仅支持读取尺寸与格式）。',
  });

  return {
    canEncode: bridge !== null,

    async probe(params) {
      // 先走纯文件头解析：快、确定、与 Pillow 语义一致
      const byHeader = probeByHeader(params);
      if (byHeader.ok) return byHeader;
      // 文件头无法识别时才让主进程用 nativeImage 兜底
      if (!bridge) return byHeader;
      try {
        return await bridge.call<ImageProbeResult>(
          AGENT_CHANNELS.imageProbe,
          params,
        );
      } catch {
        return byHeader;
      }
    },

    async toJpegDataUrl(params) {
      if (!bridge) return unavailable();
      return bridge.call<ImageDataUrlResult>(
        AGENT_CHANNELS.imageDataUrl,
        params,
      );
    },

    async cropBatch(params) {
      if (!bridge) return unavailable();
      return bridge.call<CropBatchResult>(
        AGENT_CHANNELS.imageCropBatch,
        params,
      );
    },
  };
}

/** 无桥（独立模式）的图像服务。 */
export function createStandaloneImageService(): ImageService {
  return createImageService(null);
}

/** 供测试与工具复用：把本地缩放结果包装成 data URL（无编码场景）。 */
export function wrapAsDataUrl(
  suffix: string,
  bytes: Buffer,
  width: number,
  height: number,
): { dataUrl: string; width: number; height: number } {
  return {
    dataUrl: toDataUrl(mimeFromSuffix(suffix), bytes),
    width,
    height,
  };
}

export { fitWithinMaxEdge };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 主进程侧的图像服务（替代 Python 的 Pillow）。
 *
 * 用 Electron 内置的 `nativeImage` 实现，**零新增依赖**——这正是选择它而非 `sharp`
 * 的原因（native 模块会带来 electron-rebuild 与三平台打包矩阵的负担）。
 *
 * 覆盖 Pillow 在本地 Agent 侧的全部用途：
 *   - 读尺寸/格式（`read_image_for_vision`）
 *   - 等比缩放 + JPEG 编码（附图注入）
 *   - 逐框裁剪 + 缩放 + 编码（视觉映射，阶段 7）
 *
 * 两个必须对齐的 Pillow 语义：
 *
 *   1. **尺寸取文件头而非解码结果**。Pillow 的 `Image.open(...).size` 是惰性的，
 *      只读文件头；且不应用 EXIF 旋转。本模块同样以文件头解析为主，
 *      `nativeImage` 只在文件头无法识别时兜底。
 *
 *   2. **RGBA 需合成到白底再编码 JPEG**。Pillow 侧对 RGBA/LA/P 显式铺白底；
 *      Chromium 的 JPEG 编码器对 alpha 的处理不同（会得到黑底或丢弃 alpha），
 *      因此这里手动做白底合成，保证透明 PNG 转出的 JPEG 与 Python 一致。
 */

import fs from 'fs-extra';
import path from 'path';
import { nativeImage, type NativeImage } from 'electron';
import {
  fitWithinMaxEdge,
  mimeFromSuffix,
  parseImageHeader,
  toDataUrl,
  type ImageHeaderInfo,
} from './imageOps';

export interface ImageProbeResult {
  ok: boolean;
  width?: number;
  height?: number;
  format?: string;
  /** 是否由文件头解析得到（false 表示走了 nativeImage 兜底）。 */
  fromHeader?: boolean;
  error?: string;
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
  /** 左上角与右下角（左闭右开语义由调用方决定；这里按宽高换算）。 */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CropBatchResult {
  ok: boolean;
  images?: string[];
  error?: string;
}

/** 加载图片字节：路径优先，其次 base64。 */
function loadImageBytes(params: {
  absolutePath?: string;
  base64?: string;
}): { bytes: Buffer; error?: string } {
  const abs = (params.absolutePath ?? '').trim();
  if (abs) {
    try {
      if (!fs.existsSync(abs)) {
        return { bytes: Buffer.alloc(0), error: `文件不存在：${abs}` };
      }
      return { bytes: fs.readFileSync(abs) };
    } catch (err) {
      return { bytes: Buffer.alloc(0), error: `读取图片失败：${errMessage(err)}` };
    }
  }
  const raw = (params.base64 ?? '').trim();
  if (raw) {
    // 剥离 data URL 前缀
    const comma = raw.indexOf(',');
    const payload = raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw;
    try {
      return { bytes: Buffer.from(payload, 'base64') };
    } catch (err) {
      return { bytes: Buffer.alloc(0), error: `解码 base64 失败：${errMessage(err)}` };
    }
  }
  return { bytes: Buffer.alloc(0), error: '未提供图片路径或 base64 数据。' };
}

/**
 * 读图片尺寸与格式。
 *
 * 主路径是文件头解析（语义对齐 Pillow 的惰性读取），识别失败时退回 `nativeImage` 解码。
 */
export function probeImage(params: {
  absolutePath?: string;
  base64?: string;
}): ImageProbeResult {
  const loaded = loadImageBytes(params);
  if (loaded.error) return { ok: false, error: loaded.error };
  const bytes = loaded.bytes;
  if (bytes.length === 0) return { ok: false, error: '图片数据为空。' };

  const header: ImageHeaderInfo | null = parseImageHeader(bytes);
  if (header) {
    return {
      ok: true,
      width: header.width,
      height: header.height,
      format: header.format,
      fromHeader: true,
    };
  }

  // 兜底：交给 nativeImage 解码
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) {
    return { ok: false, error: '无法识别的图片格式。' };
  }
  const { width, height } = image.getSize();
  const suffix = path.extname((params.absolutePath ?? '').trim()).toLowerCase();
  return {
    ok: true,
    width,
    height,
    // 与 Pillow 的 img.format 对齐：无后缀信息时以 MIME 反推一个合理值
    format: formatFromMime(mimeFromSuffix(suffix)),
    fromHeader: false,
  };
}

function formatFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'PNG';
    case 'image/jpeg':
      return 'JPEG';
    case 'image/gif':
      return 'GIF';
    case 'image/webp':
      return 'WEBP';
    case 'image/bmp':
      return 'BMP';
    case 'image/x-icon':
      return 'ICO';
    default:
      return 'UNKNOWN';
  }
}

/**
 * 把 `NativeImage` 的像素合成到白底。
 *
 * `toBitmap()` 返回 BGRA 布局。仅当存在非全不透明像素时才需要合成；
 * 这里统一处理，代价是一次内存拷贝。
 */
function flattenOntoWhite(image: NativeImage): NativeImage {
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return image;

  const bitmap = image.toBitmap();
  if (bitmap.length < width * height * 4) return image;

  const out = Buffer.alloc(width * height * 4);
  let hasAlpha = false;
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    const b = bitmap[offset];
    const g = bitmap[offset + 1];
    const r = bitmap[offset + 2];
    const a = bitmap[offset + 3];
    if (a === 255) {
      out[offset] = b;
      out[offset + 1] = g;
      out[offset + 2] = r;
      out[offset + 3] = 255;
      continue;
    }
    hasAlpha = true;
    // 白底合成：c' = c * a + 255 * (1 - a)
    const alpha = a / 255;
    out[offset] = Math.round(b * alpha + 255 * (1 - alpha));
    out[offset + 1] = Math.round(g * alpha + 255 * (1 - alpha));
    out[offset + 2] = Math.round(r * alpha + 255 * (1 - alpha));
    out[offset + 3] = 255;
  }

  if (!hasAlpha) return image;
  return nativeImage.createFromBitmap(out, { width, height });
}

/**
 * 等比缩放并编码为 JPEG data URL。
 *
 * 只缩小不放大（对齐 Pillow 的 `scale = min(1, maxEdge / max(w, h))`）。
 */
export function imageToJpegDataUrl(params: {
  absolutePath?: string;
  base64?: string;
  maxEdge: number;
  quality: number;
}): ImageDataUrlResult {
  const loaded = loadImageBytes(params);
  if (loaded.error) return { ok: false, error: loaded.error };

  let image = nativeImage.createFromBuffer(loaded.bytes);
  if (image.isEmpty()) {
    // nativeImage 无法解码（如 GIF/WebP 变体）：退化为原字节直传
    const header = parseImageHeader(loaded.bytes);
    const suffix = path.extname((params.absolutePath ?? '').trim()).toLowerCase();
    const mime = mimeFromSuffix(suffix) !== 'application/octet-stream'
      ? mimeFromSuffix(suffix)
      : formatToMime(header?.format);
    return {
      ok: true,
      dataUrl: toDataUrl(mime, loaded.bytes),
      width: header?.width,
      height: header?.height,
      format: header?.format,
    };
  }

  const { width, height } = image.getSize();
  const target = fitWithinMaxEdge(width, height, params.maxEdge);
  if (target.scaled) {
    image = image.resize({
      width: target.width,
      height: target.height,
      quality: 'best',
    });
  }

  image = flattenOntoWhite(image);
  const jpeg = image.toJPEG(clampQuality(params.quality));
  return {
    ok: true,
    dataUrl: toDataUrl('image/jpeg', jpeg),
    width: image.getSize().width,
    height: image.getSize().height,
    format: 'JPEG',
  };
}

function formatToMime(format: string | undefined): string {
  switch (format) {
    case 'PNG':
      return 'image/png';
    case 'JPEG':
      return 'image/jpeg';
    case 'GIF':
      return 'image/gif';
    case 'WEBP':
      return 'image/webp';
    case 'BMP':
      return 'image/bmp';
    case 'ICO':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function clampQuality(quality: number): number {
  if (!Number.isFinite(quality)) return 85;
  return Math.max(0, Math.min(100, Math.round(quality)));
}

/**
 * 批量裁剪 + 等比缩放 + JPEG 编码。
 *
 * 对应 Python `map_labels_service._crop_boxes_from_image_bytes`：对每个检测框裁剪、
 * 缩放到 `maxEdge`、编码为 JPEG data URL。批量执行以避免逐框 IPC 往返。
 *
 * 坐标按 Pillow 的 `(left, top, right, bottom)` 语义，越界部分自动裁剪到图片范围内；
 * 完全在图片外的框产出空串（调用方据此判断）。
 */
export function cropImageBatch(params: {
  absolutePath?: string;
  base64?: string;
  boxes: CropBox[];
  maxEdge: number;
  quality: number;
}): CropBatchResult {
  const loaded = loadImageBytes(params);
  if (loaded.error) return { ok: false, error: loaded.error };

  const image = nativeImage.createFromBuffer(loaded.bytes);
  if (image.isEmpty()) {
    return { ok: false, error: '无法解码图片，无法裁剪。' };
  }
  const { width, height } = image.getSize();

  const images: string[] = [];
  for (const box of params.boxes) {
    const left = Math.max(0, Math.min(width, Math.floor(box.left)));
    const top = Math.max(0, Math.min(height, Math.floor(box.top)));
    const right = Math.max(left, Math.min(width, Math.ceil(box.right)));
    const bottom = Math.max(top, Math.min(height, Math.ceil(box.bottom)));
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth <= 0 || cropHeight <= 0) {
      images.push('');
      continue;
    }

    let cropped = image.crop({
      x: left,
      y: top,
      width: cropWidth,
      height: cropHeight,
    });
    const target = fitWithinMaxEdge(cropWidth, cropHeight, params.maxEdge);
    if (target.scaled) {
      cropped = cropped.resize({
        width: target.width,
        height: target.height,
        quality: 'best',
      });
    }
    cropped = flattenOntoWhite(cropped);
    images.push(toDataUrl('image/jpeg', cropped.toJPEG(clampQuality(params.quality))));
  }

  return { ok: true, images };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

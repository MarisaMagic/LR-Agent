/**
 * 图像操作的纯逻辑部分（不依赖 Electron，可单测）。
 *
 * 背景：Python 侧用 Pillow 做三件事——读尺寸/格式、等比缩放、JPEG 编码。
 * Node 侧用 Electron 内置的 `nativeImage` 覆盖后两者（`crop` / `resize` / `toJPEG`），
 * 无需引入 `sharp` 等 native 模块。
 *
 * 但 `nativeImage` 有两个不足，需要本模块补齐：
 *
 *   1. **不暴露图片格式**。Python 的 `img.format` 会返回 `PNG` / `JPEG` 等，
 *      工具结果里要带这个信息。
 *   2. **官方只保证 PNG/JPEG 解码**。对 GIF / WebP / BMP / ICO 可能返回空图像，
 *      此时需要「原字节直传 + 从文件头解析尺寸」的兜底路径。
 *
 * 因此这里实现文件头解析：既产出 `format` 字符串，也在解码失败时给出尺寸。
 */

/** 文件头解析结果。 */
export interface ImageHeaderInfo {
  width: number;
  height: number;
  /** 大写格式名（对齐 Pillow 的 `img.format`：PNG / JPEG / GIF / WEBP / BMP / ICO）。 */
  format: string;
}

function readUInt16BE(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset);
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function readUInt32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

/** PNG：签名 + IHDR 中的宽高（大端）。 */
function parsePng(buf: Buffer): ImageHeaderInfo | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: readUInt32BE(buf, 16),
    height: readUInt32BE(buf, 20),
    format: 'PNG',
  };
}

/**
 * JPEG：扫描段结构找 SOFn（帧起始），从中读高度与宽度。
 *
 * 需跳过 `0xC4`（DHT）、`0xC8`（JPG）、`0xCC`（DAC）——它们不是 SOFn。
 */
function parseJpeg(buf: Buffer): ImageHeaderInfo | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // 填充字节
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度字段的标记
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break;

    const segLength = readUInt16BE(buf, offset + 2);
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      // SOFn: [标记2][长度2][精度1][高2][宽2]
      return {
        height: readUInt16BE(buf, offset + 5),
        width: readUInt16BE(buf, offset + 7),
        format: 'JPEG',
      };
    }
    if (segLength < 2) break;
    offset += 2 + segLength;
  }
  return null;
}

/** GIF：`GIF87a` / `GIF89a` + 逻辑屏幕宽高（小端）。 */
function parseGif(buf: Buffer): ImageHeaderInfo | null {
  if (buf.length < 10) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return {
    width: readUInt16LE(buf, 6),
    height: readUInt16LE(buf, 8),
    format: 'GIF',
  };
}

/** WebP：RIFF 容器，按 VP8 / VP8L / VP8X 三种变体取尺寸。 */
function parseWebp(buf: Buffer): ImageHeaderInfo | null {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // 有损：帧头中 14 位宽、14 位高
    return {
      width: readUInt16LE(buf, 26) & 0x3fff,
      height: readUInt16LE(buf, 28) & 0x3fff,
      format: 'WEBP',
    };
  }
  if (chunk === 'VP8L') {
    // 无损：位打包的 14 位宽高
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      format: 'WEBP',
    };
  }
  if (chunk === 'VP8X') {
    // 扩展：24 位宽高（减一存储）
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { width, height, format: 'WEBP' };
  }
  return null;
}

/** BMP：`BM` + DIB 头中的宽高（小端，有符号；高度为负表示自上而下）。 */
function parseBmp(buf: Buffer): ImageHeaderInfo | null {
  if (buf.length < 26) return null;
  if (buf.toString('ascii', 0, 2) !== 'BM') return null;
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  if (width <= 0) return null;
  return { width, height: Math.abs(height), format: 'BMP' };
}

/** ICO：目录中第一个条目的宽高（0 表示 256）。 */
function parseIco(buf: Buffer): ImageHeaderInfo | null {
  if (buf.length < 22) return null;
  if (
    buf[0] !== 0x00 ||
    buf[1] !== 0x00 ||
    buf[2] !== 0x01 ||
    buf[3] !== 0x00
  ) {
    return null;
  }
  const count = readUInt16LE(buf, 4);
  if (count === 0) return null;
  const width = buf[6] === 0 ? 256 : buf[6];
  const height = buf[7] === 0 ? 256 : buf[7];
  return { width, height, format: 'ICO' };
}

/**
 * 从文件头解析图片尺寸与格式。
 *
 * 支持 PNG / JPEG / GIF / WebP / BMP / ICO；无法识别时返回 null。
 */
export function parseImageHeader(buf: Buffer): ImageHeaderInfo | null {
  return (
    parsePng(buf) ??
    parseJpeg(buf) ??
    parseGif(buf) ??
    parseWebp(buf) ??
    parseBmp(buf) ??
    parseIco(buf)
  );
}

/** 文件后缀 → data URL 的 MIME。 */
export function mimeFromSuffix(suffix: string): string {
  switch (suffix.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 等比缩放到最长边不超过 `maxEdge`。
 *
 * 对齐 Python `image_bytes_loader.resize_image_to_jpeg_bytes` 的
 * `scale = min(1.0, max_edge / max(w, h))`——**只缩小、不放大**。
 *
 * @returns 目标尺寸；无需缩放时返回原尺寸
 */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) return { width, height, scaled: false };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

/** 构造 data URL。 */
export function toDataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

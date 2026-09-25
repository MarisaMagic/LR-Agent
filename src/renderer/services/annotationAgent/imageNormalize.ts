/**
 * 逐框视觉映射的图像来源预处理。
 *
 * 背景：检测走推理侧（OpenCV），WebP / BMP / ICO 等格式都能正常出框；
 * 但**逐框裁剪走主进程的 `nativeImage`，而它官方只保证解码 PNG / JPEG**
 * （见 `src/main/agentImage/imageOps.ts` 顶部说明），其余格式可能解出空图，
 * 于是「有检测框、却没有任何裁剪图」。渲染进程是 Chromium，格式支持最全，
 * 因此这里在渲染侧先把这类图片重编码成 JPEG，再交给主进程裁剪。
 *
 * 尺寸必须保持原样：裁剪框坐标来自推理侧的原图像素空间，缩放会整体错位。
 */

/** 主进程可解码格式的判据（`nativeImage` 的保证范围）。 */
export function isNativeImageDecodable(bytes: Uint8Array): boolean {
  // PNG 签名
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return true;
  }
  // JPEG SOI
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

async function readFileBytes(absolutePath: string): Promise<Uint8Array | null> {
  const buf = await window.electron?.fileSystem?.readFileBuffer(absolutePath);
  if (!buf || buf.byteLength === 0) return null;
  return new Uint8Array(buf);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () =>
      reject(new Error('image_decode_failed')),
    );
    image.src = src;
  });
}

/**
 * 用 canvas 把任意 Chromium 可解码的图片重编码为 JPEG data URL。
 *
 * 输出尺寸与原始像素尺寸一致（不做缩放）。质量取 0.95 而非 PNG：
 * 高像素图转 PNG 会产生数十 MB 的 base64 负载，而下游裁剪本来就要编码成 JPEG。
 * 透明区域按白底合成，与主进程 `flattenOntoWhite` 的语义一致。
 *
 * @returns data URL；解码不可用时返回空串（调用方据此回退）
 */
export async function encodeImageAsJpegDataUrl(
  bytes: Uint8Array,
): Promise<string> {
  const blob = new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width <= 0 || height <= 0) return '';

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.95);
  } catch {
    return '';
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 交给映射接口的图像：路径优先，其次 base64。 */
export interface MapImageSource {
  absolutePath: string;
  base64: string;
}

/**
 * 为逐框视觉映射准备图像来源。
 *
 * PNG / JPEG 直接用绝对路径（零开销）；其余格式先转成 JPEG data URL。
 * 转换失败时回退到路径，让服务端报出真实原因。
 */
export async function prepareMapImageSource(
  absolutePath: string,
): Promise<MapImageSource> {
  const direct: MapImageSource = { absolutePath, base64: '' };
  const bytes = await readFileBytes(absolutePath);
  if (!bytes || isNativeImageDecodable(bytes)) return direct;

  const dataUrl = await encodeImageAsJpegDataUrl(bytes);
  if (!dataUrl) return direct;
  // 两者同时传时服务端优先用路径，因此这里必须清空路径
  return { absolutePath: '', base64: dataUrl };
}

/** 裁剪失败后的兜底重编码（覆盖「文件头可解析、但主进程解不出像素」的图片）。 */
export async function normalizeImageForCrop(
  absolutePath: string,
): Promise<string> {
  const bytes = await readFileBytes(absolutePath);
  if (!bytes) return '';
  return encodeImageAsJpegDataUrl(bytes);
}

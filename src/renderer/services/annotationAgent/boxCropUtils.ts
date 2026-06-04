/** 从图片按归一化 bbox 裁剪并输出 JPEG base64（fusion 逐框视觉映射） */

function loadImageFromObjectUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

export async function cropNormalizedBoxToJpegBase64(
  absolutePath: string,
  box: { x: number; y: number; width: number; height: number },
  outputSize = 384,
): Promise<string> {
  const buf = await window.electron?.fileSystem?.readFileBuffer(absolutePath);
  if (!buf || buf.byteLength === 0) return '';

  const blob = new Blob([buf]);
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImageFromObjectUrl(url);
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    if (iw <= 0 || ih <= 0) return '';

    const pad = 0.05;
    const x1 = Math.max(0, (box.x - pad) * iw);
    const y1 = Math.max(0, (box.y - pad) * ih);
    const x2 = Math.min(iw, (box.x + box.width + pad) * iw);
    const y2 = Math.min(ih, (box.y + box.height + pad) * ih);
    const cw = Math.max(1, x2 - x1);
    const ch = Math.max(1, y2 - y1);

    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x1, y1, cw, ch, 0, 0, outputSize, outputSize);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : '';
  } finally {
    URL.revokeObjectURL(url);
  }
}

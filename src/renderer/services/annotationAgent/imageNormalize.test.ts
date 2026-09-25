/**
 * 逐框视觉映射的图像预处理（协议与回退）。
 *
 * 说明：canvas 转码本身要求真实浏览器解码能力，jsdom 里 `Image` 不会加载
 * blob URL，因此这里只覆盖纯判据与「不触发 canvas」的回退分支；
 * 转码链路由 Electron 内的端到端验证覆盖。
 */

import { describe, expect, it } from '@jest/globals';
import {
  isNativeImageDecodable,
  normalizeImageForCrop,
  prepareMapImageSource,
} from './imageNormalize';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
// 现场样本：`.jpg` 后缀但实为 WebP（RIFF 容器）
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0xb0, 0xb7, 0x01, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function stubReadFileBuffer(
  impl: (filePath: string) => Promise<ArrayBuffer | null>,
): void {
  const electron = window.electron as typeof window.electron & {
    fileSystem: typeof window.electron.fileSystem;
  };
  electron.fileSystem = {
    ...electron.fileSystem,
    readFileBuffer: impl,
  };
}

describe('isNativeImageDecodable：主进程可解码判据', () => {
  it('PNG / JPEG 视为可解码', () => {
    expect(isNativeImageDecodable(PNG_BYTES)).toBe(true);
    expect(isNativeImageDecodable(JPEG_BYTES)).toBe(true);
  });

  it('WebP（RIFF）不可解码', () => {
    expect(isNativeImageDecodable(WEBP_BYTES)).toBe(false);
  });

  it('GIF / BMP / 空 buffer 不可解码', () => {
    expect(
      isNativeImageDecodable(new Uint8Array([0x47, 0x49, 0x46, 0x38])),
    ).toBe(false);
    expect(isNativeImageDecodable(new Uint8Array([0x42, 0x4d]))).toBe(false);
    expect(isNativeImageDecodable(new Uint8Array())).toBe(false);
  });

  it('短 buffer 不越界', () => {
    expect(isNativeImageDecodable(new Uint8Array([0x89]))).toBe(false);
    expect(isNativeImageDecodable(new Uint8Array([0xff]))).toBe(false);
  });
});

describe('prepareMapImageSource：优先路径、必要时才转码', () => {
  it('PNG / JPEG 直接走绝对路径（不转码）', async () => {
    stubReadFileBuffer(async () => PNG_BYTES.buffer as ArrayBuffer);
    expect(await prepareMapImageSource('C:\\imgs\\1.png')).toEqual({
      absolutePath: 'C:\\imgs\\1.png',
      base64: '',
    });

    stubReadFileBuffer(async () => JPEG_BYTES.buffer as ArrayBuffer);
    expect(await prepareMapImageSource('C:\\imgs\\1.jpg')).toEqual({
      absolutePath: 'C:\\imgs\\1.jpg',
      base64: '',
    });
  });

  it('读不到文件时回退路径，交由服务端报错', async () => {
    stubReadFileBuffer(async () => null);
    expect(await prepareMapImageSource('C:\\imgs\\missing.jpg')).toEqual({
      absolutePath: 'C:\\imgs\\missing.jpg',
      base64: '',
    });
    expect(await normalizeImageForCrop('C:\\imgs\\missing.jpg')).toBe('');
  });
});

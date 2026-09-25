/**
 * 附图注入回退路径的 MIME 判定。
 *
 * 回归背景：`nativeImage` 解不出的格式走「原字节直传」，但 MIME 原先按**后缀**取，
 * 于是「WebP 存成 .jpg」这类文件会被声明成 `image/jpeg` 而字节其实是 WebP，
 * 多模态接口要么拒绝要么解错。文件头才是字节的真身。
 *
 * 只覆盖 `isEmpty()` 回退分支：能解码的分支属于 `nativeImage` 自身能力。
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

jest.mock('electron', () => ({
  nativeImage: {
    // 一律视为解不出像素，逼出回退分支
    createFromBuffer: () => ({ isEmpty: () => true }),
  },
}));

// eslint-disable-next-line import/first
import { imageToJpegDataUrl } from './handlers';

const WEBP_BYTES = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0xb0, 0xb7, 0x01, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20, 0xa4, 0xb7, 0x01, 0x00, 0x30, 0xfe, 0x06, 0x9d, 0x01, 0x2a,
  0xb0, 0x04, 0xa3, 0x02,
]);

let tmpDir = '';

function write(name: string, bytes: Buffer): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-img-handlers-'));
});

afterAll(() => {
  fs.removeSync(tmpDir);
});

describe('imageToJpegDataUrl：回退分支的 MIME 以文件头为准', () => {
  it('WebP 字节配 .jpg 后缀时声明 image/webp', () => {
    const result = imageToJpegDataUrl({
      absolutePath: write('4.jpg', WEBP_BYTES),
      maxEdge: 1280,
      quality: 85,
    });

    expect(result.ok).toBe(true);
    expect(result.dataUrl?.startsWith('data:image/webp;base64,')).toBe(true);
    expect(result.format).toBe('WEBP');
    // 尺寸来自文件头（VP8 有损：14 位宽高）
    expect(result.width).toBe(1200);
    expect(result.height).toBe(675);
  });

  it('文件头无法识别时退回后缀', () => {
    const result = imageToJpegDataUrl({
      absolutePath: write('mystery.png', Buffer.from('not an image')),
      maxEdge: 1280,
      quality: 85,
    });

    expect(result.ok).toBe(true);
    expect(result.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('文件头与后缀都识别不出时退化为 octet-stream', () => {
    const result = imageToJpegDataUrl({
      absolutePath: write('mystery.bin', Buffer.from('not an image')),
      maxEdge: 1280,
      quality: 85,
    });

    expect(
      result.dataUrl?.startsWith('data:application/octet-stream;base64,'),
    ).toBe(true);
  });
});

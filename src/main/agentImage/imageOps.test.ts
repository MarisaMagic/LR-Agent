/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import zlib from 'node:zlib';
import {
  fitWithinMaxEdge,
  mimeFromSuffix,
  parseImageHeader,
  toDataUrl,
} from './imageOps';

/** 构造最小 PNG 头（签名 + IHDR）。 */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** 构造最小 JPEG（SOI + SOF0 + EOI）。 */
function jpegBytes(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9, // EOI
  ]);
}

/** 构造最小 GIF 头。 */
function gifBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** 构造 VP8X 变体的 WebP 头。 */
function webpBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // 24 位宽高（减一存储）
  buf[24] = (width - 1) & 0xff;
  buf[25] = ((width - 1) >> 8) & 0xff;
  buf[26] = ((width - 1) >> 16) & 0xff;
  buf[27] = (height - 1) & 0xff;
  buf[28] = ((height - 1) >> 8) & 0xff;
  buf[29] = ((height - 1) >> 16) & 0xff;
  return buf;
}

/** 构造 BMP 头。 */
function bmpBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('BM', 0, 'ascii');
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

/** 构造 ICO 头。 */
function icoBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(1, 4);
  buf[6] = width === 256 ? 0 : width;
  buf[7] = height === 256 ? 0 : height;
  return buf;
}

describe('parseImageHeader：文件头解析', () => {
  it('PNG 读出宽高与格式', () => {
    expect(parseImageHeader(pngBytes(800, 600))).toEqual({
      width: 800,
      height: 600,
      format: 'PNG',
    });
  });

  it('JPEG 读出宽高与格式', () => {
    expect(parseImageHeader(jpegBytes(1024, 768))).toEqual({
      width: 1024,
      height: 768,
      format: 'JPEG',
    });
  });

  it('JPEG 跳过非 SOF 段（DHT/DAC）', () => {
    // SOI + DHT（0xC4，无帧信息）+ SOF0 + EOI
    const buf = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
      0xff, 0xd9,
    ]);
    const info = parseImageHeader(buf);
    expect(info).toEqual({ width: 400, height: 300, format: 'JPEG' });
  });

  it('GIF 读出宽高与格式', () => {
    expect(parseImageHeader(gifBytes(320, 240))).toEqual({
      width: 320,
      height: 240,
      format: 'GIF',
    });
  });

  it('WebP（VP8X）读出宽高与格式', () => {
    expect(parseImageHeader(webpBytes(1000, 500))).toEqual({
      width: 1000,
      height: 500,
      format: 'WEBP',
    });
  });

  it('BMP 读出宽高（高度取绝对值）', () => {
    expect(parseImageHeader(bmpBytes(64, 48))).toEqual({
      width: 64,
      height: 48,
      format: 'BMP',
    });
    // 负高度表示自上而下存储
    const topDown = bmpBytes(64, -48);
    expect(parseImageHeader(topDown)?.height).toBe(48);
  });

  it('ICO 读出宽高与格式', () => {
    expect(parseImageHeader(icoBytes(32, 32))).toEqual({
      width: 32,
      height: 32,
      format: 'ICO',
    });
  });

  it('ICO 的 0 表示 256', () => {
    expect(parseImageHeader(icoBytes(256, 256))?.width).toBe(256);
  });

  it('无法识别时返回 null', () => {
    expect(parseImageHeader(Buffer.from('not an image at all'))).toBeNull();
  });

  it('空 buffer 返回 null 而不抛异常', () => {
    expect(parseImageHeader(Buffer.alloc(0))).toBeNull();
  });

  it('截断的 PNG 返回 null 而不抛异常', () => {
    expect(parseImageHeader(pngBytes(10, 10).subarray(0, 10))).toBeNull();
  });
});

describe('fitWithinMaxEdge：等比缩放', () => {
  it('超出最长边时按比例缩小', () => {
    expect(fitWithinMaxEdge(2560, 1440, 1280)).toEqual({
      width: 1280,
      height: 720,
      scaled: true,
    });
  });

  it('只缩小不放大（对齐 Pillow 的 min(1.0, ...)）', () => {
    expect(fitWithinMaxEdge(100, 80, 1280)).toEqual({
      width: 100,
      height: 80,
      scaled: false,
    });
  });

  it('恰好等于上限时不缩放', () => {
    expect(fitWithinMaxEdge(1280, 800, 1280).scaled).toBe(false);
  });

  it('竖图按高度约束', () => {
    expect(fitWithinMaxEdge(600, 1200, 600)).toEqual({
      width: 300,
      height: 600,
      scaled: true,
    });
  });

  it('极端比例不会产生 0 尺寸', () => {
    const result = fitWithinMaxEdge(10000, 3, 100);
    expect(result.width).toBe(100);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it('非法尺寸原样返回', () => {
    expect(fitWithinMaxEdge(0, 0, 100).scaled).toBe(false);
  });
});

describe('mimeFromSuffix 与 toDataUrl', () => {
  it('常见后缀映射到正确 MIME', () => {
    expect(mimeFromSuffix('.png')).toBe('image/png');
    expect(mimeFromSuffix('.jpeg')).toBe('image/jpeg');
    expect(mimeFromSuffix('.JPG')).toBe('image/jpeg');
    expect(mimeFromSuffix('.webp')).toBe('image/webp');
  });

  it('未知后缀退化为 octet-stream', () => {
    expect(mimeFromSuffix('.xyz')).toBe('application/octet-stream');
  });

  it('toDataUrl 产出标准 data URL', () => {
    expect(toDataUrl('image/jpeg', Buffer.from([1, 2, 3]))).toBe(
      'data:image/jpeg;base64,AQID',
    );
  });
});

describe('PDF 文本提取：辅助函数', () => {
  it('zlib 解压能力可用（PDF FlateDecode 依赖它）', () => {
    const original = Buffer.from('BT (hello) Tj ET');
    const deflated = zlib.deflateSync(original);
    expect(zlib.inflateSync(deflated).toString('latin1')).toBe(
      'BT (hello) Tj ET',
    );
  });
});

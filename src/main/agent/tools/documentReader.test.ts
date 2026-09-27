/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import zlib from 'node:zlib';
import { extractPdfText, extractTextFromContentStream } from './documentReader';

/** 构造一个含单页、内容流可指定压缩方式的最小 PDF。 */
function buildPdf(
  content: string,
  options: { compress?: boolean } = {},
): Buffer {
  const contentBytes = Buffer.from(content, 'latin1');
  const streamData = options.compress
    ? zlib.deflateSync(contentBytes)
    : contentBytes;
  const filter = options.compress ? ' /Filter /FlateDecode' : '';

  const parts: string[] = [];
  parts.push('%PDF-1.4\n');

  // 1: Catalog
  parts.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  // 2: Pages
  parts.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  // 3: Page
  parts.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n',
  );
  // 4: Contents（二进制部分用 latin1 拼接以保字节）
  const head = Buffer.from(
    `4 0 obj\n<< /Length ${streamData.length}${filter} >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
  parts.push('');
  const prefix = Buffer.from(parts.join(''), 'latin1');
  return Buffer.concat([prefix, head, streamData, tail]);
}

describe('extractTextFromContentStream：文本算子', () => {
  it('提取 Tj 的字符串', () => {
    expect(extractTextFromContentStream(Buffer.from('BT (Hello) Tj ET'))).toBe(
      'Hello',
    );
  });

  it('多行 Tj 通过 Td 分隔', () => {
    const content = 'BT (Line1) Tj Td (Line2) Tj ET';
    expect(extractTextFromContentStream(Buffer.from(content))).toBe(
      'Line1\nLine2',
    );
  });

  it('TJ 数组按顺序拼接字符串', () => {
    const content = 'BT [(Hel) -100 (lo)] TJ ET';
    expect(extractTextFromContentStream(Buffer.from(content))).toBe('Hello');
  });

  it('从 Td 切换行（换行提示）', () => {
    const content = 'BT (A) Tj Td (B) Tj T* (C) Tj ET';
    expect(extractTextFromContentStream(Buffer.from(content))).toBe('A\nB\nC');
  });

  it("' 算子换行", () => {
    const content = "BT (A) Tj (B) ' ET";
    expect(extractTextFromContentStream(Buffer.from(content))).toBe('A\nB');
  });

  it('解码字面量转义', () => {
    const content = 'BT (a\\nb\\(c\\)d\\\\e) Tj ET';
    expect(extractTextFromContentStream(Buffer.from(content))).toBe(
      'a\nb(c)d\\e',
    );
  });

  it('解码八进制转义', () => {
    // \101 = 'A'
    expect(
      extractTextFromContentStream(Buffer.from('BT (\\101\\102) Tj ET')),
    ).toBe('AB');
  });

  it('处理嵌套括号', () => {
    expect(extractTextFromContentStream(Buffer.from('BT (a(b)c) Tj ET'))).toBe(
      'a(b)c',
    );
  });

  it('解码十六进制字符串', () => {
    // 48656c6c6f = "Hello"
    expect(
      extractTextFromContentStream(Buffer.from('BT <48656c6c6f> Tj ET')),
    ).toBe('Hello');
  });

  it('十六进制字符串奇数长度时补齐', () => {
    expect(
      extractTextFromContentStream(Buffer.from('BT <48656c6c6f7> Tj ET')),
    ).toBe('Hello\x70');
  });

  it('FEFF 前缀按 UTF-16BE 解码', () => {
    // FEFF 4F60 597D = "你好"
    expect(
      extractTextFromContentStream(Buffer.from('BT <FEFF4F60597D> Tj ET')),
    ).toBe('你好');
  });

  it('忽略注释与数字', () => {
    expect(
      extractTextFromContentStream(Buffer.from('% comment\nBT (X) Tj ET')),
    ).toBe('X');
  });

  it('无文本时返回空串', () => {
    expect(extractTextFromContentStream(Buffer.from('0 0 1 RG'))).toBe('');
  });
});

/** 构造一个含多页、内容流未压缩的最小 PDF（页顺序按对象号升序）。 */
function buildMultiPagePdf(pages: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const kids = pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ');
  parts.push(
    Buffer.from(
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`,
      'latin1',
    ),
  );
  pages.forEach((content, i) => {
    const pageObj = 3 + 2 * i;
    const contentObj = 4 + 2 * i;
    const data = Buffer.from(content, 'latin1');
    parts.push(
      Buffer.from(
        `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${contentObj} 0 R >>\nendobj\n` +
          `${contentObj} 0 obj\n<< /Length ${data.length} >>\nstream\n`,
        'latin1',
      ),
    );
    parts.push(data);
    parts.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  });
  return Buffer.concat(parts);
}

describe('extractPdfText：页提取', () => {
  it('提取未压缩内容流的文本', () => {
    const pdf = buildPdf('BT (Plain text) Tj ET');
    const result = extractPdfText(pdf, { maxPages: 30 });
    expect(result.total).toBe(1);
    expect(result.extracted).toBe(1);
    expect(result.text).toContain('Plain text');
  });

  it('提取 FlateDecode 压缩内容流的文本', () => {
    const pdf = buildPdf('BT (Compressed text) Tj ET', { compress: true });
    const result = extractPdfText(pdf, { maxPages: 30 });
    expect(result.text).toContain('Compressed text');
  });

  it('maxPages 限制提取页数', () => {
    const pdf = buildPdf('BT (X) Tj ET');
    const result = extractPdfText(pdf, { maxPages: 0 });
    // 至少提取 1 页（对齐 Python 的 limit = min(total, max_pages) 与 Math.max(1, ...)）
    expect(result.extracted).toBeGreaterThanOrEqual(1);
  });

  it('非 PDF 内容不抛异常', () => {
    expect(() =>
      extractPdfText(Buffer.from('not a pdf'), { maxPages: 10 }),
    ).not.toThrow();
    const result = extractPdfText(Buffer.from('not a pdf'), { maxPages: 10 });
    expect(result.total).toBe(0);
    expect(result.text).toBe('');
  });

  it('空 buffer 不抛异常', () => {
    const result = extractPdfText(Buffer.alloc(0), { maxPages: 10 });
    expect(result.total).toBe(0);
  });
});

describe('extractPdfText：分页', () => {
  it('startPage 指定起始页并返回页范围', () => {
    const pdf = buildMultiPagePdf([
      'BT (Page one) Tj ET',
      'BT (Page two) Tj ET',
      'BT (Page three) Tj ET',
    ]);
    const result = extractPdfText(pdf, { startPage: 2, maxPages: 1 });
    expect(result.total).toBe(3);
    expect(result.extracted).toBe(1);
    expect(result.startPage).toBe(2);
    expect(result.endPage).toBe(2);
    expect(result.text).toContain('Page two');
    expect(result.text).not.toContain('Page one');
  });

  it('从起始页提取到剩余页数为止', () => {
    const pdf = buildMultiPagePdf([
      'BT (A) Tj ET',
      'BT (B) Tj ET',
      'BT (C) Tj ET',
    ]);
    const result = extractPdfText(pdf, { startPage: 2, maxPages: 10 });
    expect(result.extracted).toBe(2);
    expect(result.startPage).toBe(2);
    expect(result.endPage).toBe(3);
    expect(result.text).toContain('B');
    expect(result.text).toContain('C');
  });

  it('startPage 超出总页数返回 0 页', () => {
    const pdf = buildMultiPagePdf(['BT (Only) Tj ET']);
    const result = extractPdfText(pdf, { startPage: 5, maxPages: 1 });
    expect(result.total).toBe(1);
    expect(result.extracted).toBe(0);
    expect(result.startPage).toBe(5);
    expect(result.endPage).toBe(4);
    expect(result.text).toBe('');
  });
});

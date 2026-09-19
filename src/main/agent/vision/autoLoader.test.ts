/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  VisionAutoLoader,
  canBootstrapVision,
  pickVisionRelativePath,
  visionRelativeFromUserText,
} from './autoLoader';
import {
  buildMultimodalUserMessage,
  VISION_ATTACHMENT_TEXT,
} from '../context/multimodal';
import { createImageService } from '../services/imageService';
import type { ImageService } from '../services/imageService';
import { DEFAULT_AGENT_SETTINGS } from '../config';
import type { ChatMessage } from '../llm/client';
import type { StreamEventPayload } from '../sse';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-vision-'));
});

afterEach(async () => {
  await fs.remove(workspace);
});

/** 写一个最小 PNG（文件名可指定）。 */
async function writePng(
  relative: string,
  width = 640,
  height = 480,
): Promise<string> {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  const abs = path.join(workspace, relative);
  await fs.ensureDir(path.dirname(abs));
  await fs.writeFile(abs, buf);
  return abs;
}

const ctx = () => ({ workspaceRoot: workspace, projectDirectoryPath: null });

/** 编码总是成功的替身服务。 */
function fakeEncoder(): ImageService {
  return {
    canEncode: true,
    async probe() {
      return { ok: true, width: 640, height: 480, format: 'PNG' };
    },
    async toJpegDataUrl() {
      return {
        ok: true,
        dataUrl: 'data:image/jpeg;base64,AAAA',
        width: 640,
        height: 480,
      };
    },
    async cropBatch() {
      return { ok: true, images: [] };
    },
  };
}

/** 模拟真实 nativeImage 行为的替身：路径不存在时编码失败。 */
function pathCheckingEncoder(): ImageService {
  return {
    canEncode: true,
    async probe() {
      return { ok: false, error: 'not found' };
    },
    async toJpegDataUrl(params) {
      const abs = params.absolutePath ?? '';
      if (!abs || !fs.existsSync(abs)) {
        return { ok: false, error: `文件不存在：${abs}` };
      }
      return { ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' };
    },
    async cropBatch() {
      return { ok: false, error: 'not found' };
    },
  };
}

async function collect(
  gen: AsyncGenerator<StreamEventPayload>,
): Promise<StreamEventPayload[]> {
  const out: StreamEventPayload[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('visionRelativeFromUserText：从用户文本解析图片路径', () => {
  it('解析行首的图片路径', () => {
    expect(visionRelativeFromUserText('data/1.jpg 里有什么')).toBe(
      'data/1.jpg',
    );
  });

  it('解析空白后的图片路径', () => {
    expect(visionRelativeFromUserText('看看 data/2.png 这张图')).toBe(
      'data/2.png',
    );
  });

  it('解析「『引号后的图片路径', () => {
    expect(visionRelativeFromUserText('看「data/3.webp」')).toBe('data/3.webp');
  });

  it('反斜杠路径归一为正斜杠', () => {
    expect(visionRelativeFromUserText('看看 data\\sub\\4.bmp 这张图')).toBe(
      'data/sub/4.bmp',
    );
  });

  it('大小写不敏感', () => {
    expect(visionRelativeFromUserText('看 data/5.JPG')).toBe('data/5.JPG');
  });

  it('不在分隔位置时不上当（避免正文误判）', () => {
    expect(visionRelativeFromUserText('文件是data/1.jpg')).toBe('');
  });

  it('无图片路径时返回空串', () => {
    expect(visionRelativeFromUserText('帮我看看这个文件夹')).toBe('');
  });

  it('不支持的后缀不匹配', () => {
    expect(visionRelativeFromUserText('看看 data/1.txt')).toBe('');
  });
});

describe('pickVisionRelativePath 与 canBootstrapVision', () => {
  it('优先取 active_relative_path', () => {
    expect(
      pickVisionRelativePath({
        workspaceRoot: workspace,
        activeRelativePath: 'a/b.png',
      }),
    ).toBe('a/b.png');
  });

  it('未打开文件时返回空串', () => {
    expect(pickVisionRelativePath({ workspaceRoot: workspace })).toBe('');
  });

  it('存在的图片可通过校验', async () => {
    await writePng('data/ok.png');
    expect(canBootstrapVision(ctx(), 'data/ok.png')).toBe(true);
  });

  it('不存在的文件不通过', () => {
    expect(canBootstrapVision(ctx(), 'data/missing.png')).toBe(false);
  });

  it('非图片后缀不通过', async () => {
    await fs.writeFile(path.join(workspace, 'note.md'), 'x');
    expect(canBootstrapVision(ctx(), 'note.md')).toBe(false);
  });
});

describe('VisionAutoLoader.shouldLoad', () => {
  const params = (
    overrides: Partial<ConstructorParameters<typeof VisionAutoLoader>[0]> = {},
  ) => ({
    settings: DEFAULT_AGENT_SETTINGS,
    clientContext: ctx(),
    providerIsVision: true,
    userContent: '看看 data/1.jpg',
    imageService: fakeEncoder(),
    ...overrides,
  });

  it('非 resume + 支持视觉 + 文本含图片路径 → 触发', () => {
    expect(new VisionAutoLoader(params()).shouldLoad(false)).toBe(true);
  });

  it('resume 时不触发', () => {
    expect(new VisionAutoLoader(params()).shouldLoad(true)).toBe(false);
  });

  it('provider 不支持视觉时不触发', () => {
    expect(
      new VisionAutoLoader(params({ providerIsVision: false })).shouldLoad(
        false,
      ),
    ).toBe(false);
  });

  it('文本无图片路径时不触发', () => {
    expect(
      new VisionAutoLoader(params({ userContent: '帮我看看目录' })).shouldLoad(
        false,
      ),
    ).toBe(false);
  });
});

describe('VisionAutoLoader.tryFallback', () => {
  it('优先使用当前打开的图片并注入附图', async () => {
    await writePng('data/opened.png');
    const messages: ChatMessage[] = [];
    const loader = new VisionAutoLoader({
      settings: DEFAULT_AGENT_SETTINGS,
      clientContext: {
        workspaceRoot: workspace,
        activeRelativePath: 'data/opened.png',
      },
      providerIsVision: true,
      userContent: '这张图里有什么',
      imageService: fakeEncoder(),
    });

    const events = await collect(loader.tryFallback(messages));

    expect(events[0].type).toBe('tool_start');
    expect(events[0].name).toBe('read_image_for_vision');
    expect(events[1].type).toBe('tool_result');

    // 工具 id 形态与 Python 一致
    expect(String(events[0].toolCallId)).toMatch(
      /^lr-vision-fallback-[0-9a-f]{10}$/,
    );

    // 追加 ToolMessage + 附图 HumanMessage
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('tool');
    expect(messages[1].role).toBe('user');
    expect(Array.isArray(messages[1].content)).toBe(true);
  });

  it('无打开文件时回退到用户文本中的路径', async () => {
    await writePng('data/from-text.png');
    const messages: ChatMessage[] = [];
    const loader = new VisionAutoLoader({
      settings: DEFAULT_AGENT_SETTINGS,
      clientContext: ctx(),
      providerIsVision: true,
      userContent: '看看 data/from-text.png',
      imageService: fakeEncoder(),
    });

    const events = await collect(loader.tryFallback(messages));
    expect(events).toHaveLength(2);
    expect(messages).toHaveLength(2);
  });

  it('路径不存在时不产出任何事件', async () => {
    const messages: ChatMessage[] = [];
    const loader = new VisionAutoLoader({
      settings: DEFAULT_AGENT_SETTINGS,
      clientContext: ctx(),
      providerIsVision: true,
      userContent: '看看 data/missing.jpg',
      imageService: fakeEncoder(),
    });

    expect(await collect(loader.tryFallback(messages))).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  it('结果剥离内部标记，且输出完整缩进 JSON（非 summary）', async () => {
    await writePng('data/opened.png');
    const loader = new VisionAutoLoader({
      settings: DEFAULT_AGENT_SETTINGS,
      clientContext: {
        workspaceRoot: workspace,
        activeRelativePath: 'data/opened.png',
      },
      providerIsVision: true,
      userContent: '看图',
      imageService: fakeEncoder(),
    });

    const events = await collect(loader.tryFallback([]));
    const result = String(events[1].result);

    // 不应包含内部标记
    expect(result).not.toContain('__vision_image_path__');
    // 应是缩进 JSON（含换行），而不是被折叠成 message 单行文本
    expect(result).toContain('\n');
    // 且保留结构化字段
    expect(JSON.parse(result)).toMatchObject({
      ok: true,
      width: 640,
      height: 480,
    });
  });

  it('无编码能力时仍追加纯文本消息（退化不抛异常）', async () => {
    await writePng('data/opened.png');
    const standalone = createImageService(null);
    expect(standalone.canEncode).toBe(false);

    const messages: ChatMessage[] = [];
    const loader = new VisionAutoLoader({
      settings: DEFAULT_AGENT_SETTINGS,
      clientContext: {
        workspaceRoot: workspace,
        activeRelativePath: 'data/opened.png',
      },
      providerIsVision: true,
      userContent: '看图',
      imageService: standalone,
    });

    await collect(loader.tryFallback(messages));
    // 工具结果 + 退化的纯文本消息
    expect(messages).toHaveLength(2);
    expect(typeof messages[1].content).toBe('string');
  });
});

describe('buildMultimodalUserMessage', () => {
  it('路径无效时退化为纯文本（模拟真实 nativeImage 的空图像行为）', async () => {
    const msg = await buildMultimodalUserMessage(
      'text',
      { imageAbsolutePath: '/nonexistent.png', maxEdge: 1280, jpegQuality: 85 },
      pathCheckingEncoder(),
    );
    expect(msg.content).toBe('text');
  });

  it('编码失败时退化为纯文本', async () => {
    await writePng('data/x.png');
    const failing: ImageService = {
      canEncode: true,
      async probe() {
        return { ok: true, width: 1, height: 1, format: 'PNG' };
      },
      async toJpegDataUrl() {
        return { ok: false, error: 'boom' };
      },
      async cropBatch() {
        return { ok: false, error: 'boom' };
      },
    };
    const msg = await buildMultimodalUserMessage(
      'text',
      {
        imageAbsolutePath: path.join(workspace, 'data/x.png'),
        maxEdge: 1280,
        jpegQuality: 85,
      },
      failing,
    );
    expect(msg.content).toBe('text');
  });

  it('编码成功时产出 text + image_url 两段内容', async () => {
    const msg = await buildMultimodalUserMessage(
      '看图',
      { imageAbsolutePath: 'whatever.png', maxEdge: 1280, jpegQuality: 85 },
      fakeEncoder(),
    );
    expect(msg.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ]);
  });

  it('给定存在的文件路径时产出附图', async () => {
    await writePng('data/real.png');
    const msg = await buildMultimodalUserMessage(
      '看图',
      {
        imageAbsolutePath: path.join(workspace, 'data/real.png'),
        maxEdge: 1280,
        jpegQuality: 85,
      },
      pathCheckingEncoder(),
    );
    expect(Array.isArray(msg.content)).toBe(true);
  });

  it('未提供图片时直接返回纯文本', async () => {
    const msg = await buildMultimodalUserMessage(
      'text',
      { maxEdge: 1280, jpegQuality: 85 },
      fakeEncoder(),
    );
    expect(msg.content).toBe('text');
  });

  it('附图提示文本固定', () => {
    expect(VISION_ATTACHMENT_TEXT).toBe(
      '【附图】请根据上图回答用户关于该图片的问题。',
    );
  });
});

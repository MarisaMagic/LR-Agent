/**
 * 逐框视觉映射的裁剪失败契约。
 *
 * 回归背景：`cropImageBatch` 失败时，这里原先仍返回 `ok: true` + 空 `mappings`，
 * 上游只能报出「mappings 为空」，把「图片解不出像素」这类真因盖掉
 * （现场：`.jpg` 后缀的 WebP 文件，检测正常出框、裁剪全失败）。
 */

import { describe, expect, it } from '@jest/globals';
import { DEFAULT_AGENT_SETTINGS } from '../config';
import type { LlmClient } from '../llm/client';
import type { ImageService } from '../services/imageService';
import { mapDetectionBoxesToLabelsUnified } from './mapLabels';

const LABELS = [
  { id: 'L1', name: '斯蒂芬库里' },
  { id: 'L2', name: '勒布朗詹姆斯' },
];

function boxes(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_item, i) => ({
    box_index: i,
    x: 0.1,
    y: 0.2,
    width: 0.3,
    height: 0.4,
    class_name: 'person',
    confidence: 0.9,
  }));
}

function imageServiceStub(crop: ImageService['cropBatch']): ImageService {
  return {
    canEncode: true,
    probe: async () => ({ ok: true, width: 1200, height: 675, format: 'WEBP' }),
    toJpegDataUrl: async () => ({ ok: false, error: 'not_used' }),
    cropBatch: crop,
  };
}

/** 只在真正发起视觉调用时才被调用的桩：裁剪失败路径不应碰它。 */
function llmStub(onCall?: () => void): LlmClient {
  return {
    completeChat: async () => {
      onCall?.();
      return {
        content: '{"label_id":"L1","reason":"stub"}',
        reasoning: '',
        toolCalls: [],
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as LlmClient;
}

/** 映射结果里本测试关心的字段。 */
interface MapOutcome {
  ok?: boolean;
  error?: string;
  method?: string;
  hint?: string;
  mappings?: Array<{ box_index: number; label_id: string }>;
}

async function runMap(params: {
  imageService: ImageService;
  llm?: LlmClient | null;
  boxList?: Array<Record<string, unknown>>;
}): Promise<MapOutcome> {
  return (await mapDetectionBoxesToLabelsUnified({
    llm: params.llm ?? llmStub(),
    userRequest: '标注库里',
    intentSummary: '标注球员',
    labelCandidates: LABELS,
    boxes: params.boxList ?? boxes(2),
    useVision: true,
    ocrText: '',
    scope: null,
    labelStrategy: 'per_box',
    singleLabelId: null,
    imageAbsolutePath: 'C:\\imgs\\4.jpg',
    imageBase64: '',
    mimeType: 'image/jpeg',
    settings: {
      ...DEFAULT_AGENT_SETTINGS,
      annotationLabelPoolPreflight: 'off',
      annotationVisionMapValidate: false,
    },
    imageService: params.imageService,
    imageAvailable: true,
  })) as MapOutcome;
}

describe('mapDetectionBoxesToLabelsUnified：裁剪失败必须显式失败', () => {
  it('裁剪整批失败时返回 crop_unavailable 而非空 mappings', async () => {
    const result = await runMap({
      imageService: imageServiceStub(async () => ({
        ok: false,
        error: '无法解码图片，无法裁剪。',
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('crop_unavailable');
    expect(result.method).toBe('vision_crop');
    expect(result.mappings).toBeUndefined();
    expect(String(result.hint)).toContain('无法解码图片，无法裁剪。');
  });

  it('裁剪成功但产出空串时同样返回 crop_unavailable', async () => {
    const result = await runMap({
      imageService: imageServiceStub(async () => ({
        ok: true,
        images: ['', ''],
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('crop_unavailable');
    expect(String(result.hint)).toContain('裁剪结果为空图');
  });

  it('尺寸探测失败时给出探测原因', async () => {
    const broken: ImageService = {
      ...imageServiceStub(async () => ({ ok: true, images: [] })),
      probe: async () => ({ ok: false, error: '文件不存在：C:\\imgs\\4.jpg' }),
    };
    const result = await runMap({ imageService: broken });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('crop_unavailable');
    expect(String(result.hint)).toContain('文件不存在');
  });

  it('检测框宽高非法时给出框原因（且不调用解码）', async () => {
    let cropped = false;
    const result = await runMap({
      imageService: imageServiceStub(async () => {
        cropped = true;
        return { ok: true, images: ['data:image/jpeg;base64,AAAA'] };
      }),
      boxList: [
        { box_index: 0, x: 0.1, y: 0.1, width: 0, height: 0.2 },
        { box_index: 1, x: 0.1, y: 0.1, width: 0.2, height: 0 },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('crop_unavailable');
    expect(String(result.hint)).toContain('检测框宽高或坐标非法');
    expect(cropped).toBe(false);
  });

  it('裁剪可用时照常返回逐框映射', async () => {
    let llmCalls = 0;
    const result = await runMap({
      imageService: imageServiceStub(async () => ({
        ok: true,
        images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
      })),
      llm: llmStub(() => {
        llmCalls += 1;
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.method).toBe('vision_crop');
    expect(result.mappings).toHaveLength(2);
    expect(result.mappings?.[0]).toMatchObject({
      box_index: 0,
      label_id: 'L1',
    });
    expect(llmCalls).toBe(2);
  });
});

describe('mapDetectionBoxesToLabelsUnified：标签唯一性策略', () => {
  const cropOk = imageServiceStub(async () => ({
    ok: true,
    images: ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
  }));

  async function runWith(uniqueness: 'allow' | 'enforce') {
    let calls = 0;
    const result = (await mapDetectionBoxesToLabelsUnified({
      llm: llmStub(() => {
        calls += 1;
      }),
      userRequest: '补标签',
      intentSummary: '补标签',
      labelCandidates: LABELS,
      boxes: boxes(2),
      useVision: true,
      ocrText: '',
      scope: null,
      labelStrategy: 'map_each_box_to_label',
      labelUniqueness: uniqueness,
      singleLabelId: null,
      imageAbsolutePath: 'C:\\imgs\\4.jpg',
      imageBase64: '',
      mimeType: 'image/jpeg',
      settings: {
        ...DEFAULT_AGENT_SETTINGS,
        annotationLabelPoolPreflight: 'off',
        annotationVisionMapValidate: true,
        annotationVisionMapMaxRetries: 1,
      },
      imageService: cropOk,
      imageAvailable: true,
    })) as MapOutcome;
    return { result, calls };
  }

  it('allow：同类多实例共用标签，不因重复触发重试', async () => {
    const { result, calls } = await runWith('allow');
    expect(result.ok).toBe(true);
    expect(result.mappings?.map((m) => m.label_id)).toEqual(['L1', 'L1']);
    expect(calls).toBe(2);
  });

  it('enforce：重复标签视为问题并触发重试', async () => {
    const { calls } = await runWith('enforce');
    expect(calls).toBeGreaterThan(2);
  });
});

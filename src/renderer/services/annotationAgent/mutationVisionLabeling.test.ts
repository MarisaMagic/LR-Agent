import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnnotationInstance } from '../../types/annotationDocument';
import { mapDetectionBoxesUnified } from '../annotationAgentApi';
import {
  buildBoxesFromAnnotations,
  labelBoxesByVision,
} from './mutationVisionLabeling';

jest.mock('../annotationAgentApi', () => ({
  mapDetectionBoxesUnified: jest.fn(),
}));
jest.mock('./imageNormalize', () => ({
  prepareMapImageSource: jest.fn(async (absolutePath: string) => ({
    absolutePath,
    base64: '',
  })),
  normalizeImageForCrop: jest.fn(async () => ''),
}));
jest.mock('./fusionSubImageTools', () => ({
  readImageBase64: jest.fn(async () => ''),
}));

const mockedMap = jest.mocked(mapDetectionBoxesUnified);

const LABELS = [
  { id: 'l1', name: '苹果', color: '#F44336' },
  { id: 'l2', name: '香蕉', color: '#E91E63' },
];

function annotations(): AnnotationInstance[] {
  return [
    {
      id: 'a1',
      kind: 'bbox',
      labelId: null,
      createdAt: '',
      updatedAt: '',
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    },
    {
      id: 'a2',
      kind: 'rotated_bbox',
      labelId: 'l1',
      createdAt: '',
      updatedAt: '',
      cx: 0.5,
      cy: 0.5,
      width: 0.2,
      height: 0.1,
      angle: 0,
    },
    {
      id: 'a3',
      kind: 'polygon',
      labelId: null,
      createdAt: '',
      updatedAt: '',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.3, y: 0.1 },
        { x: 0.3, y: 0.3 },
      ],
    },
    {
      id: 'a4',
      kind: 'caption',
      labelId: null,
      createdAt: '',
      updatedAt: '',
      text: '说明',
      granularity: 'brief',
    },
  ];
}

beforeEach(() => {
  mockedMap.mockReset();
});

describe('buildBoxesFromAnnotations', () => {
  it('几何标注转为归一化框并给出回映；非几何标注跳过', () => {
    const { boxes, idByBoxIndex } = buildBoxesFromAnnotations(
      annotations(),
      ['a1', 'a2', 'a3', 'a4'],
      new Map([['l1', '苹果']]),
    );

    expect(boxes.map((b) => b.box_index)).toEqual([0, 1, 2]);
    expect(idByBoxIndex.get(0)).toBe('a1');
    expect(idByBoxIndex.get(2)).toBe('a3');
    expect(boxes[0]).toMatchObject({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
      class_name: '',
    });
    // 旋转框取 AABB；class_name 取现有标签名
    expect(boxes[1].class_name).toBe('苹果');
    expect(boxes[1].width).toBeCloseTo(0.2);
    // 多边形取包围盒
    expect(boxes[2]).toMatchObject({ x: 0.1, y: 0.1 });
  });
});

describe('labelBoxesByVision', () => {
  it('回映视觉结果：合法标签写入、空标签与非法 id 计为留空', async () => {
    mockedMap.mockResolvedValue({
      ok: true,
      mappings: [
        { box_index: 0, label_id: 'l1', reason: '苹果' },
        { box_index: 1, label_id: '', reason: '无法确定' },
        { box_index: 2, label_id: 'unknown', reason: '乱码' },
      ],
    });

    const result = await labelBoxesByVision({
      providerId: 'p1',
      userRequest: '补标签',
      intentSummary: '补标签',
      imageAbsolutePath: 'C:\\imgs\\1.jpg',
      annotations: annotations(),
      ids: ['a1', 'a2', 'a3', 'a4'],
      labels: LABELS,
    });

    expect(result.labelsById.get('a1')).toBe('l1');
    expect(result.labelsById.has('a2')).toBe(false);
    expect(result.labelsById.has('a3')).toBe(false);
    // a2 空标签 + a3 非法 id
    expect(result.unmappedCount).toBe(2);
    expect(mockedMap).toHaveBeenCalledTimes(1);
  });

  it('无可映射几何框时直接返回错误，不调用视觉接口', async () => {
    const result = await labelBoxesByVision({
      providerId: 'p1',
      userRequest: '补标签',
      intentSummary: '补标签',
      imageAbsolutePath: 'C:\\imgs\\1.jpg',
      annotations: annotations(),
      ids: ['a4'],
      labels: LABELS,
    });

    expect(result.labelsById.size).toBe(0);
    expect(result.error).toBe('无可用几何框');
    expect(mockedMap).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from '@jest/globals';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import {
  describeNoEligibleModelReason,
  getEligiblePreAnnotModels,
} from './preAnnotModelFilter';

/** 只填筛选相关字段的最小模型。 */
function model(patch: Partial<PretrainedModelConfig>): PretrainedModelConfig {
  return {
    id: 'm1',
    name: 'M',
    modelType: 'object_detection',
    enabled: true,
    isDefault: false,
    checkpointPath: 'D:/models/yolov8n.pt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('getEligiblePreAnnotModels', () => {
  it('矩形框只接受 Detect，排除 OBB 与停用项', () => {
    const detect = model({ id: 'detect', checkpointPath: 'D:/m/yolov8n.pt' });
    const obb = model({
      id: 'obb',
      checkpointPath: 'D:/m/yolov8n.pt',
      detectionMode: 'obb',
    });
    const disabled = model({ id: 'off', enabled: false });

    const eligible = getEligiblePreAnnotModels('bbox', [detect, obb, disabled]);
    expect(eligible.map((m) => m.id)).toEqual(['detect']);
  });

  it('旋转框只接受 OBB', () => {
    const detect = model({ id: 'detect' });
    const obb = model({ id: 'obb', detectionMode: 'obb' });

    const eligible = getEligiblePreAnnotModels('rotated_bbox', [detect, obb]);
    expect(eligible.map((m) => m.id)).toEqual(['obb']);
  });

  it('矩形框同时接受 Detect 与开放词表', () => {
    const detect = model({ id: 'detect' });
    const openVocab = model({
      id: 'world',
      detectionMode: 'open_vocab',
      checkpointPath: 'D:/m/yolov8s-worldv2.pt',
    });
    const obb = model({ id: 'obb', detectionMode: 'obb' });

    const eligible = getEligiblePreAnnotModels('bbox', [
      detect,
      openVocab,
      obb,
    ]);
    expect(eligible.map((m) => m.id)).toEqual(['detect', 'world']);
  });

  it('开放词表模型不进入旋转框下拉', () => {
    const openVocab = model({
      id: 'world',
      detectionMode: 'open_vocab',
      checkpointPath: 'D:/m/yolov8s-worldv2.pt',
    });
    expect(getEligiblePreAnnotModels('rotated_bbox', [openVocab])).toHaveLength(
      0,
    );
  });

  it('多边形只接受分割模型', () => {
    const det = model({ id: 'det' });
    const sam = model({ id: 'sam', modelType: 'image_segmentation' });

    const eligible = getEligiblePreAnnotModels('polygon', [det, sam]);
    expect(eligible.map((m) => m.id)).toEqual(['sam']);
  });

  it('关键点要求绑定当前骨架模板', () => {
    const person = model({
      id: 'person',
      modelType: 'keypoint_estimation',
      keypointTemplateIds: ['person_coco'],
    });
    const hand = model({
      id: 'hand',
      modelType: 'keypoint_estimation',
      keypointTemplateIds: ['hand'],
    });

    expect(
      getEligiblePreAnnotModels('keypoint', [person, hand], 'person_coco').map(
        (m) => m.id,
      ),
    ).toEqual(['person']);
    // 未选模板时不额外过滤
    expect(
      getEligiblePreAnnotModels('keypoint', [person, hand]).map((m) => m.id),
    ).toEqual(['person', 'hand']);
  });
});

describe('describeNoEligibleModelReason', () => {
  it('复现真实故障：唯一的检测模型被标成 OBB，矩形框下给出可操作原因', () => {
    const models = [
      model({
        checkpointPath: 'C:/Users/user/Desktop/yolov8/yolov8n.pt',
        detectionMode: 'obb',
      }),
    ];
    // 前提：筛选结果确实为空，否则提示没有意义
    expect(getEligiblePreAnnotModels('bbox', models)).toHaveLength(0);

    const reason = describeNoEligibleModelReason('bbox', models);
    expect(reason).toContain('旋转框 (OBB)');
    expect(reason).toContain('检测模式');
  });

  it('全部停用时提示去启用', () => {
    const models = [model({ enabled: false })];
    expect(describeNoEligibleModelReason('bbox', models)).toContain('停用');
  });

  it('完全没有模型时提示去添加', () => {
    expect(describeNoEligibleModelReason('bbox', [])).toContain('尚未配置');
  });

  it('旋转框下检测模型都是 Detect 时给出对应原因', () => {
    const models = [model({ checkpointPath: 'D:/m/yolov8n.pt' })];
    expect(getEligiblePreAnnotModels('rotated_bbox', models)).toHaveLength(0);
    expect(describeNoEligibleModelReason('rotated_bbox', models)).toContain(
      '普通矩形框',
    );
  });

  it('多边形缺少 SAM2 时提示配置分割模型', () => {
    const models = [model({ checkpointPath: 'D:/m/yolov8n.pt' })];
    expect(describeNoEligibleModelReason('polygon', models)).toContain('SAM2');
  });

  it('关键点模型未绑定当前模板时点明原因', () => {
    const models = [
      model({
        modelType: 'keypoint_estimation',
        keypointTemplateIds: ['hand'],
      }),
    ];
    expect(
      describeNoEligibleModelReason('keypoint', models, 'person_coco'),
    ).toContain('骨架模板');
  });

  it('关键点无任何关键点模型时提示配置', () => {
    const models = [model({ checkpointPath: 'D:/m/yolov8n.pt' })];
    expect(describeNoEligibleModelReason('keypoint', models)).toContain(
      '关键点估计模型',
    );
  });

  it('存在可用模型时返回 null', () => {
    const models = [model({ checkpointPath: 'D:/m/yolov8n.pt' })];
    expect(describeNoEligibleModelReason('bbox', models)).toBeNull();
  });

  it('仅有开放词表检测模型时矩形框可用', () => {
    const models = [
      model({
        detectionMode: 'open_vocab',
        checkpointPath: 'D:/m/yolov8s-worldv2.pt',
      }),
    ];
    expect(getEligiblePreAnnotModels('bbox', models)).toHaveLength(1);
    expect(describeNoEligibleModelReason('bbox', models)).toBeNull();
    // 旋转框下仍不可用，且原因指向需要 OBB
    expect(describeNoEligibleModelReason('rotated_bbox', models)).toContain(
      'OBB',
    );
  });
});

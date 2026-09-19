import { describe, expect, it } from '@jest/globals';
import type { PretrainedModelConfig } from './pretrainedModelTypes';
import {
  describeDetectionModeMismatch,
  inferDetectionMode,
} from './preAnnotTypes';

/** 只填检测模式推断相关字段的最小模型。 */
function model(patch: Partial<PretrainedModelConfig>): PretrainedModelConfig {
  return {
    id: 'm1',
    name: 'YOLOv8',
    modelType: 'object_detection',
    enabled: true,
    isDefault: false,
    checkpointPath: 'D:/models/yolov8n.pt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('inferDetectionMode', () => {
  it('显式值优先于文件名（真实故障场景：yolov8n.pt 被标成 obb）', () => {
    expect(
      inferDetectionMode(
        model({
          checkpointPath: 'C:/Users/user/Desktop/yolov8/yolov8n.pt',
          detectionMode: 'obb',
        }),
      ),
    ).toBe('obb');
  });

  it('显式 detect 压过含 obb 的文件名', () => {
    expect(
      inferDetectionMode(
        model({
          checkpointPath: 'D:/models/best-obb.pt',
          detectionMode: 'detect',
        }),
      ),
    ).toBe('detect');
  });

  it('未设置时按文件名推断 obb', () => {
    expect(
      inferDetectionMode(model({ checkpointPath: 'D:/models/yolov8n-obb.pt' })),
    ).toBe('obb');
  });

  it('未设置且文件名无 obb 时回退 detect', () => {
    expect(
      inferDetectionMode(
        model({
          checkpointPath: 'D:/models/yolov8n.pt',
          detectionMode: undefined,
        }),
      ),
    ).toBe('detect');
  });
});

describe('describeDetectionModeMismatch', () => {
  it('检出「OBB 声明 + 普通检测权重名」的矛盾', () => {
    const message = describeDetectionModeMismatch({
      detectionMode: 'obb',
      checkpointPath: 'C:\\Users\\user\\Desktop\\yolov8\\yolov8n.pt',
    });
    expect(message).not.toBeNull();
    expect(message).toContain('旋转框 (OBB)');
    // 必须点明后果，否则用户不知道模型为何在标注界面消失
    expect(message).toContain('矩形框');
  });

  it('检出「Detect 声明 + obb 文件名」的矛盾', () => {
    expect(
      describeDetectionModeMismatch({
        detectionMode: 'detect',
        checkpointPath: 'D:/models/yolov8n-obb.pt',
      }),
    ).toContain('普通矩形框');
  });

  it('模式与文件名一致时不告警', () => {
    expect(
      describeDetectionModeMismatch({
        detectionMode: 'obb',
        checkpointPath: 'D:/models/yolov8n-obb.pt',
      }),
    ).toBeNull();
    expect(
      describeDetectionModeMismatch({
        detectionMode: 'detect',
        checkpointPath: 'D:/models/yolov8n.pt',
      }),
    ).toBeNull();
  });

  it('模式未设置或路径为空时不做判断', () => {
    expect(
      describeDetectionModeMismatch({
        detectionMode: undefined,
        checkpointPath: 'D:/models/yolov8n.pt',
      }),
    ).toBeNull();
    expect(
      describeDetectionModeMismatch({
        detectionMode: 'obb',
        checkpointPath: '',
      }),
    ).toBeNull();
  });

  it('自训练的 OBB 权重（仅目录含 obb）不误报', () => {
    // ultralytics 的 OBB 训练输出常为 runs/obb/train/weights/best.pt
    expect(
      describeDetectionModeMismatch({
        detectionMode: 'obb',
        checkpointPath: 'D:/runs/obb/train/weights/best.pt',
      }),
    ).toBeNull();
  });

  it('obb 必须是独立词元，避免 "bobby" 之类误判', () => {
    expect(
      describeDetectionModeMismatch({
        detectionMode: 'obb',
        checkpointPath: 'C:/Users/bobby/models/yolov8n.pt',
      }),
    ).not.toBeNull();
  });
});

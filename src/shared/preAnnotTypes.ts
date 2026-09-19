import type {
  PretrainedModelConfig,
  PretrainedModelParams,
  ObjectDetectionMode,
} from './pretrainedModelTypes';

export type PreAnnotJobKind =
  'yolo_detect' | 'yolo_obb' | 'sam2_box' | 'keypoint_full' | 'keypoint_roi';

export interface PreAnnotNormBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface PreAnnotRequest {
  jobId: string;
  kind: PreAnnotJobKind;
  imagePath: string;
  model: PretrainedModelConfig;
  box?: PreAnnotNormBox;
  templateId?: string;
  overrides?: Partial<PretrainedModelParams>;
}

export interface PreAnnotDetectItem {
  className: string;
  classId: number;
  confidence: number;
  geometry:
    | {
        x: number;
        y: number;
        width: number;
        height: number;
      }
    | {
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
      };
}

export interface PreAnnotDetectResult {
  items: PreAnnotDetectItem[];
  classNames?: string[];
}

export interface PreAnnotPolygonResult {
  points: { x: number; y: number }[];
  score?: number;
}

export interface PreAnnotPoseItem {
  templateId: string;
  confidence: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  keypoints: {
    x: number;
    y: number;
    visibility: 0 | 1 | 2;
    confidence: number;
  }[];
}

export interface PreAnnotPoseResult {
  poses: PreAnnotPoseItem[];
}

export type PreAnnotResult =
  PreAnnotDetectResult | PreAnnotPolygonResult | PreAnnotPoseResult;

export interface PreAnnotRuntimeInfo {
  pythonOk: boolean;
  pythonVersion?: string;
  pythonPath?: string;
  inferenceRoot?: string;
  torchVersion?: string | null;
  cudaAvailable?: boolean;
  ultralytics?: boolean;
  sam2?: boolean;
  mediapipe?: boolean;
  faceAlignment?: boolean;
  opencv?: boolean;
  error?: string;
}

export interface PreAnnotRunResponse {
  ok: boolean;
  result?: PreAnnotResult;
  error?: string;
  trace?: string;
}

export type AnnotationSource = 'manual' | 'preannot';

export type { ObjectDetectionMode };

export function isDetectResult(
  result: PreAnnotResult,
): result is PreAnnotDetectResult {
  return 'items' in result;
}

export function isPolygonResult(
  result: PreAnnotResult,
): result is PreAnnotPolygonResult {
  return 'points' in result && !('items' in result);
}

export function isPoseResult(
  result: PreAnnotResult,
): result is PreAnnotPoseResult {
  return 'poses' in result;
}

export function inferDetectionMode(
  model: PretrainedModelConfig,
): ObjectDetectionMode {
  if (model.detectionMode === 'obb' || model.detectionMode === 'detect') {
    return model.detectionMode;
  }
  const base = model.checkpointPath.replace(/\\/g, '/').split('/').pop() ?? '';
  return /obb/i.test(base) ? 'obb' : 'detect';
}

function checkpointBasename(filePath: string | undefined): string {
  return (filePath ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
}

/**
 * 路径中是否存在 obb 证据（作为独立词元，避免 "bobby" 之类的误判）。
 *
 * 用完整路径而非仅文件名：自训练权重常命名为 `best.pt`，其 OBB 身份只体现在
 * 目录上（如 ultralytics 的 `runs/obb/train/weights/`）。
 */
function pathLooksObb(filePath: string | undefined): boolean {
  return /\bobb\b/i.test(filePath ?? '');
}

/**
 * 检测模式声明与路径证据是否矛盾。
 *
 * `detectionMode` 决定模型出现在「矩形框」还是「旋转框」预标注下拉框
 * （见 `getEligiblePreAnnotModels`）。一旦与权重类型不符，模型会在标注界面
 * 静默消失（下拉框只显示「无可用模型」），而配置列表看不出异常 —— 极难自查。
 *
 * 返回告警文案；一致或信息不足时返回 null。配置表单内联提示与保存校验共用
 * 此判据，避免两处逻辑漂移。注意这不构成硬错误：权重命名不受约束，故只作提醒、
 * 不阻断保存。
 */
export function describeDetectionModeMismatch(model: {
  detectionMode?: ObjectDetectionMode;
  checkpointPath?: string;
}): string | null {
  const declared = model.detectionMode;
  if (declared !== 'detect' && declared !== 'obb') return null;
  if (!checkpointBasename(model.checkpointPath)) return null;

  const looksObb = pathLooksObb(model.checkpointPath);
  if (declared === 'obb' && !looksObb) {
    return (
      '检测模式为旋转框 (OBB)，但文件名与路径都不含 obb。若这是普通检测权重，' +
      '需改选「普通矩形框 (Detect)」，否则该模型不会出现在矩形框标注的模型列表里。'
    );
  }
  if (declared === 'detect' && looksObb) {
    return '文件名或路径含 obb，但检测模式选的是「普通矩形框 (Detect)」，请确认是否选错。';
  }
  return null;
}

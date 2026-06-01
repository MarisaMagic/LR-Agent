import type { AnnotationType, ImageAnnotationType } from '../renderer/types/annotation';

export type ExportFormatId =
  | 'yolo'
  | 'coco'
  | 'voc'
  | 'labelme'
  | 'csv'
  | 'yolo_seg'
  | 'yolo_obb'
  | 'dota'
  | 'yolo_pose'
  | 'lr_agent';

export type ExportCoordinateMode = 'pixel' | 'normalized';

export interface ExportFormatOption {
  id: ExportFormatId;
  label: string;
  description: string;
  /** File extension hint for single-file exports */
  extension?: string;
}

export interface AnnotationExportOptions {
  format: ExportFormatId;
  outputDir: string;
  coordinateMode: ExportCoordinateMode;
  /** Include indexed images with zero annotations */
  includeEmptyImages: boolean;
}

export interface KeypointTemplateExportMeta {
  id: string;
  name: string;
  keypoints: { name: string }[];
}

export interface AnnotationExportRequest {
  project: {
    id: string;
    name: string;
    directoryPath: string;
    modality: 'text' | 'image';
    annotationType: AnnotationType;
    labels: { id: string; name: string; color: string }[];
  };
  options: AnnotationExportOptions;
  keypointTemplates?: KeypointTemplateExportMeta[];
}

export interface AnnotationExportResult {
  success: boolean;
  outputDir: string;
  filesWritten: number;
  imageCount: number;
  annotationCount: number;
  /** Training formats skip annotations with no labelId */
  skippedUnlabeledCount?: number;
  message: string;
  error?: string;
}

const IMAGE_BBOX_FORMATS: ExportFormatOption[] = [
  {
    id: 'yolo',
    label: 'YOLO Detection',
    description: 'labels/*.txt + data.yaml，归一化 cx cy w h',
  },
  {
    id: 'coco',
    label: 'COCO JSON',
    description: 'instances.json，bbox 为像素 [x,y,w,h]',
  },
  {
    id: 'voc',
    label: 'Pascal VOC XML',
    description: 'Annotations/*.xml，xmin/ymin/xmax/ymax',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: '每张图一个 JSON，矩形或多边形点集',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: '扁平 CSV：image, class, x, y, w, h',
  },
  {
    id: 'lr_agent',
    label: 'LR-Agent 原生 JSON',
    description: '完整保留 annotations/files 结构备份',
  },
];

const IMAGE_POLYGON_FORMATS: ExportFormatOption[] = [
  {
    id: 'coco',
    label: 'COCO JSON (分割)',
    description: 'segmentation 多边形 + bbox 外接矩形',
  },
  {
    id: 'yolo_seg',
    label: 'YOLO Segmentation',
    description: 'labels/*.txt，归一化多边形顶点',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: '每张图一个 JSON polygon 点集',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: '每行一个顶点：image, class, vertex_index, x, y',
  },
  {
    id: 'lr_agent',
    label: 'LR-Agent 原生 JSON',
    description: '完整保留 annotations/files 结构备份',
  },
];

const IMAGE_KEYPOINT_FORMATS: ExportFormatOption[] = [
  {
    id: 'coco',
    label: 'COCO Keypoints JSON',
    description: '骨架实例 keypoints + bbox（pose 模式）',
  },
  {
    id: 'yolo_pose',
    label: 'YOLO Pose',
    description: 'labels/*.txt，bbox + 关键点坐标',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: '点/线段 shape（pose 与单点）',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: 'image, class, kpt_index, x, y, visibility',
  },
  {
    id: 'lr_agent',
    label: 'LR-Agent 原生 JSON',
    description: '完整保留 annotations/files 结构备份',
  },
];

const IMAGE_ROTATED_BBOX_FORMATS: ExportFormatOption[] = [
  {
    id: 'yolo_obb',
    label: 'YOLO OBB',
    description: 'labels/*.txt，cx cy w h angle（弧度）',
  },
  {
    id: 'dota',
    label: 'DOTA',
    description: 'labelTxt/*.txt，四角点 x1 y1 … x4 y4',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: '旋转矩形转为 4 点多边形',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: 'image, class, cx, cy, w, h, angle_deg',
  },
  {
    id: 'lr_agent',
    label: 'LR-Agent 原生 JSON',
    description: '完整保留 annotations/files 结构备份',
  },
];

export function getExportFormatsForType(
  annotationType: AnnotationType,
): ExportFormatOption[] {
  switch (annotationType) {
    case 'bbox':
      return IMAGE_BBOX_FORMATS;
    case 'polygon':
      return IMAGE_POLYGON_FORMATS;
    case 'keypoint':
      return IMAGE_KEYPOINT_FORMATS;
    case 'rotated_bbox':
      return IMAGE_ROTATED_BBOX_FORMATS;
    default:
      return [
        {
          id: 'lr_agent',
          label: 'LR-Agent 原生 JSON',
          description: '完整保留 annotations/files 结构备份',
        },
      ];
  }
}

export function isImageAnnotationType(
  value: AnnotationType,
): value is ImageAnnotationType {
  return (
    value === 'bbox' ||
    value === 'polygon' ||
    value === 'keypoint' ||
    value === 'rotated_bbox'
  );
}

export function defaultExportFormat(
  annotationType: AnnotationType,
): ExportFormatId {
  const formats = getExportFormatsForType(annotationType);
  return formats[0]?.id ?? 'lr_agent';
}

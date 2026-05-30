import type { AnnotationType, Modality } from './annotation';

export interface AnnotationSourceMeta {
  width: number;
  height: number;
  /** Last known file modification time when saved */
  mtimeMs?: number;
  /** File size when saved */
  size?: number;
}

export interface AnnotationBase {
  id: string;
  labelId: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface BboxAnnotation extends AnnotationBase {
  kind: 'bbox';
  /** Normalized coordinates 0–1 vs natural image dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RotatedBboxAnnotation extends AnnotationBase {
  kind: 'rotated_bbox';
  /** Center point, normalized 0–1 vs natural image dimensions */
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Rotation in degrees */
  angle: number;
}

/** Placeholders for upcoming modalities — stored but not editable in bbox UI yet */
export interface PolygonAnnotation extends AnnotationBase {
  kind: 'polygon';
  /** Normalized vertices 0–1 vs natural image dimensions */
  points: { x: number; y: number }[];
}

export interface SpanAnnotation extends AnnotationBase {
  kind: 'span_ner';
  start: number;
  end: number;
}

export type AnnotationInstance =
  | BboxAnnotation
  | RotatedBboxAnnotation
  | PolygonAnnotation
  | SpanAnnotation;

export const FILE_ANNOTATION_SCHEMA_VERSION = 1;

export interface FileAnnotationDocument {
  schemaVersion: number;
  projectId: string;
  /** POSIX relative path inside project dir */
  filePath: string;
  modality: Modality;
  annotationType: AnnotationType;
  source?: AnnotationSourceMeta;
  annotations: AnnotationInstance[];
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

function isAnnotBase(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  id: string;
  labelId: string;
  createdAt: string;
  updatedAt: string;
} {
  return (
    typeof record.id === 'string' &&
    typeof record.labelId === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

export function parsePolygonAnnotation(
  raw: Record<string, unknown>,
): PolygonAnnotation | null {
  if (raw.kind !== 'polygon' || !isAnnotBase(raw)) return null;
  if (!Array.isArray(raw.points) || raw.points.length < 3) return null;
  const points: { x: number; y: number }[] = [];
  for (const pt of raw.points) {
    if (!isRecord(pt) || typeof pt.x !== 'number' || typeof pt.y !== 'number') {
      return null;
    }
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
    points.push({ x: pt.x, y: pt.y });
  }
  return {
    id: raw.id,
    labelId: raw.labelId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    kind: 'polygon',
    points,
  };
}

export function parseRotatedBboxAnnotation(
  raw: Record<string, unknown>,
): RotatedBboxAnnotation | null {
  if (
    raw.kind !== 'rotated_bbox' ||
    typeof raw.cx !== 'number' ||
    typeof raw.cy !== 'number' ||
    typeof raw.width !== 'number' ||
    typeof raw.height !== 'number' ||
    typeof raw.angle !== 'number'
  ) {
    return null;
  }
  if (!isAnnotBase(raw)) return null;
  return {
    id: raw.id,
    labelId: raw.labelId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    kind: 'rotated_bbox',
    cx: raw.cx,
    cy: raw.cy,
    width: raw.width,
    height: raw.height,
    angle: raw.angle,
  };
}

export function parseBboxAnnotation(
  raw: Record<string, unknown>,
): BboxAnnotation | null {
  if (
    raw.kind !== 'bbox' ||
    typeof raw.x !== 'number' ||
    typeof raw.y !== 'number' ||
    typeof raw.width !== 'number' ||
    typeof raw.height !== 'number'
  ) {
    return null;
  }
  if (!isAnnotBase(raw)) return null;
  return {
    id: raw.id,
    labelId: raw.labelId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    note: typeof raw.note === 'string' ? raw.note : undefined,
    kind: 'bbox',
    x: raw.x,
    y: raw.y,
    width: raw.width,
    height: raw.height,
  };
}

/** Keep unknown kinds as skipped; bbox kept for workspace */
export function parseAnnotationInstance(
  item: unknown,
): AnnotationInstance | null {
  if (!isRecord(item)) return null;
  if (typeof item.kind === 'string') {
    if (item.kind === 'bbox') return parseBboxAnnotation(item);
    if (item.kind === 'rotated_bbox') return parseRotatedBboxAnnotation(item);
    if (item.kind === 'polygon') return parsePolygonAnnotation(item);
    if (
      item.kind === 'span_ner' &&
      typeof item.start === 'number' &&
      typeof item.end === 'number' &&
      isAnnotBase(item)
    ) {
      return {
        id: item.id,
        labelId: item.labelId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        note: typeof item.note === 'string' ? item.note : undefined,
        kind: 'span_ner',
        start: item.start,
        end: item.end,
      };
    }
  }
  return null;
}

export function parseFileAnnotationDocument(
  raw: unknown,
): FileAnnotationDocument | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.schemaVersion !== 'number' ||
    typeof raw.projectId !== 'string' ||
    typeof raw.filePath !== 'string' ||
    typeof raw.updatedAt !== 'string' ||
    (raw.modality !== 'image' && raw.modality !== 'text') ||
    typeof raw.annotationType !== 'string' ||
    !Array.isArray(raw.annotations)
  ) {
    return null;
  }
  const annotations = raw.annotations
    .map(parseAnnotationInstance)
    .filter(Boolean) as AnnotationInstance[];

  const sourceUnknown = raw.source;
  let source: AnnotationSourceMeta | undefined;
  if (isRecord(sourceUnknown)) {
    if (
      typeof sourceUnknown.width === 'number' &&
      typeof sourceUnknown.height === 'number'
    ) {
      source = {
        width: sourceUnknown.width,
        height: sourceUnknown.height,
        ...(typeof sourceUnknown.mtimeMs === 'number' && {
          mtimeMs: sourceUnknown.mtimeMs,
        }),
        ...(typeof sourceUnknown.size === 'number' && {
          size: sourceUnknown.size,
        }),
      };
    }
  }

  return {
    schemaVersion: raw.schemaVersion,
    projectId: raw.projectId,
    filePath: raw.filePath,
    modality: raw.modality as Modality,
    annotationType: raw.annotationType as AnnotationType,
    source,
    annotations,
    updatedAt: raw.updatedAt,
  };
}

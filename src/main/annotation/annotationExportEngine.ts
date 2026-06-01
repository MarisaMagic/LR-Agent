import path from 'path';
import fs from 'fs-extra';
import type {
  AnnotationExportOptions,
  AnnotationExportRequest,
  AnnotationExportResult,
  KeypointTemplateExportMeta,
} from '../../shared/annotationExportTypes';
import { shouldSkipForTrainingExport } from '../../shared/annotationLabel';
import {
  loadAllAnnotationDocs,
  annotationsRoot,
} from './annotationDataStore';

interface LabelDef {
  id: string;
  name: string;
}

interface SourceMeta {
  width: number;
  height: number;
}

interface LoadedDoc {
  relativePath: string;
  filePath: string;
  source: SourceMeta;
  annotations: Record<string, unknown>[];
}

interface BboxNorm {
  x: number;
  y: number;
  width: number;
  height: number;
}

function stemFromRelative(relativePath: string): string {
  const base = path.posix.basename(relativePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function labelIndex(labels: LabelDef[], labelId: string): number {
  const idx = labels.findIndex((l) => l.id === labelId);
  return idx >= 0 ? idx : 0;
}

function labelName(labels: LabelDef[], labelId: string): string {
  return labels.find((l) => l.id === labelId)?.name ?? 'unknown';
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function toPixel(v: number, size: number): number {
  return Math.round(v * size * 1000) / 1000;
}

function bboxTopLeftToCenter(b: BboxNorm): BboxNorm {
  return {
    x: b.x + b.width / 2,
    y: b.y + b.height / 2,
    width: b.width,
    height: b.height,
  };
}

function rotatedCornersPx(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDeg: number,
): [number, number][] {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = w / 2;
  const hh = h / 2;
  const locals: [number, number][] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return locals.map(([lx, ly]) => [
    Math.round((cx + lx * cos - ly * sin) * 1000) / 1000,
    Math.round((cy + lx * sin + ly * cos) * 1000) / 1000,
  ]);
}

function parseLoadedDocs(
  rawDocs: Array<{ relativePath: string; doc: unknown }>,
  includeEmpty: boolean,
): LoadedDoc[] {
  const result: LoadedDoc[] = [];
  for (const { relativePath, doc } of rawDocs) {
    if (!doc || typeof doc !== 'object') continue;
    const record = doc as Record<string, unknown>;
    const sourceRaw = record.source;
    if (
      !sourceRaw ||
      typeof sourceRaw !== 'object' ||
      typeof (sourceRaw as SourceMeta).width !== 'number' ||
      typeof (sourceRaw as SourceMeta).height !== 'number'
    ) {
      continue;
    }
    const source = sourceRaw as SourceMeta;
    const annotations = Array.isArray(record.annotations)
      ? (record.annotations as Record<string, unknown>[])
      : [];
    if (!includeEmpty && annotations.length === 0) continue;
    result.push({
      relativePath,
      filePath:
        typeof record.filePath === 'string' ? record.filePath : relativePath,
      source,
      annotations,
    });
  }
  return result;
}

function filterDocsForTrainingExport(docs: LoadedDoc[]): {
  docs: LoadedDoc[];
  skippedUnlabeled: number;
} {
  let skippedUnlabeled = 0;
  const filtered = docs.map((doc) => ({
    ...doc,
    annotations: doc.annotations.filter((ann) => {
      if (shouldSkipForTrainingExport(ann.labelId)) {
        skippedUnlabeled += 1;
        return false;
      }
      return true;
    }),
  }));
  return { docs: filtered, skippedUnlabeled };
}

function ensureDir(dir: string): Promise<void> {
  return fs.ensureDir(dir);
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, data, { spaces: 2 });
}

function fmtNum(
  value: number,
  mode: AnnotationExportOptions['coordinateMode'],
  size: number,
): number {
  if (mode === 'normalized') return Math.round(value * 1000000) / 1000000;
  return toPixel(value, size);
}

function fmtCoordPair(
  x: number,
  y: number,
  mode: AnnotationExportOptions['coordinateMode'],
  w: number,
  h: number,
): [number, number] {
  if (mode === 'normalized') {
    return [Math.round(x * 1000000) / 1000000, Math.round(y * 1000000) / 1000000];
  }
  return [toPixel(x, w), toPixel(y, h)];
}

function axisAlignedBboxFromKeypoints(
  keypoints: { x: number; y: number; visibility: number }[],
  imgW: number,
  imgH: number,
): [number, number, number, number] {
  const visible = keypoints.filter((kp) => kp.visibility > 0);
  if (visible.length === 0) return [0, 0, imgW, imgH];
  const xs = visible.map((kp) => kp.x * imgW);
  const ys = visible.map((kp) => kp.y * imgH);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return [minX, minY, maxX - minX, maxY - minY];
}

function getTemplateMeta(
  templateId: string,
  templates: KeypointTemplateExportMeta[] | undefined,
): KeypointTemplateExportMeta | undefined {
  return templates?.find((t) => t.id === templateId);
}

async function exportNative(
  projectDir: string,
  outputDir: string,
  docs: LoadedDoc[],
): Promise<number> {
  const destRoot = path.join(outputDir, 'lr-agent-export');
  const srcRoot = annotationsRoot(projectDir);
  await fs.copy(srcRoot, destRoot, { overwrite: true });
  const manifest = {
    exportedAt: new Date().toISOString(),
    imageCount: docs.length,
    annotationCount: docs.reduce((n, d) => n + d.annotations.length, 0),
  };
  await writeJson(path.join(outputDir, 'export-manifest.json'), manifest);
  return docs.length + 1;
}

async function exportBboxYolo(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
): Promise<number> {
  const labelsDir = path.join(outputDir, 'labels');
  const imagesDir = path.join(outputDir, 'images');
  await ensureDir(labelsDir);
  await ensureDir(imagesDir);

  let files = 0;
  for (const doc of docs) {
    const lines: string[] = [];
    for (const ann of doc.annotations) {
      if (ann.kind !== 'bbox') continue;
      const cls = labelIndex(labels, String(ann.labelId));
      const center = bboxTopLeftToCenter({
        x: Number(ann.x),
        y: Number(ann.y),
        width: Number(ann.width),
        height: Number(ann.height),
      });
      lines.push(
        `${cls} ${center.x.toFixed(6)} ${center.y.toFixed(6)} ${center.width.toFixed(6)} ${center.height.toFixed(6)}`,
      );
    }
    const stem = stemFromRelative(doc.relativePath);
    await writeText(path.join(labelsDir, `${stem}.txt`), lines.join('\n'));
    files += 1;
  }

  const yaml = [
    `path: ${JSON.stringify(outputDir)}`,
    'train: images',
    'val: images',
    `names:`,
    ...labels.map((l, i) => `  ${i}: ${JSON.stringify(l.name)}`),
    '',
  ].join('\n');
  await writeText(path.join(outputDir, 'data.yaml'), yaml);
  files += 1;
  return files;
}

async function exportBboxCoco(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  projectName: string,
): Promise<number> {
  const images: Record<string, unknown>[] = [];
  const annotations: Record<string, unknown>[] = [];
  let annId = 1;

  docs.forEach((doc, imgIdx) => {
    const imageId = imgIdx + 1;
    images.push({
      id: imageId,
      file_name: doc.filePath.replace(/\\/g, '/'),
      width: doc.source.width,
      height: doc.source.height,
    });
    for (const ann of doc.annotations) {
      if (ann.kind !== 'bbox') continue;
      const cls = labelIndex(labels, String(ann.labelId)) + 1;
      annotations.push({
        id: annId++,
        image_id: imageId,
        category_id: cls,
        bbox: [
          toPixel(Number(ann.x), doc.source.width),
          toPixel(Number(ann.y), doc.source.height),
          toPixel(Number(ann.width), doc.source.width),
          toPixel(Number(ann.height), doc.source.height),
        ],
        area:
          toPixel(Number(ann.width), doc.source.width) *
          toPixel(Number(ann.height), doc.source.height),
        iscrowd: 0,
      });
    }
  });

  const categories = labels.map((l, i) => ({
    id: i + 1,
    name: l.name,
    supercategory: 'object',
  }));

  await writeJson(path.join(outputDir, 'instances.json'), {
    info: {
      description: projectName,
      version: '1.0',
      year: new Date().getFullYear(),
      contributor: 'LR-Agent',
      date_created: new Date().toISOString(),
    },
    licenses: [],
    images,
    annotations,
    categories,
  });
  return 1;
}

async function exportBboxVoc(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
): Promise<number> {
  const annDir = path.join(outputDir, 'Annotations');
  await ensureDir(annDir);
  let files = 0;

  for (const doc of docs) {
    const objects = doc.annotations
      .filter((a) => a.kind === 'bbox')
      .map((ann) => {
        const xmin = toPixel(Number(ann.x), doc.source.width);
        const ymin = toPixel(Number(ann.y), doc.source.height);
        const xmax = toPixel(
          Number(ann.x) + Number(ann.width),
          doc.source.width,
        );
        const ymax = toPixel(
          Number(ann.y) + Number(ann.height),
          doc.source.height,
        );
        return `    <object>
      <name>${escapeXml(labelName(labels, String(ann.labelId)))}</name>
      <pose>Unspecified</pose>
      <truncated>0</truncated>
      <difficult>0</difficult>
      <bndbox>
        <xmin>${xmin}</xmin>
        <ymin>${ymin}</ymin>
        <xmax>${xmax}</xmax>
        <ymax>${ymax}</ymax>
      </bndbox>
    </object>`;
      });

    const fileName = path.posix.basename(doc.filePath);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<annotation>
  <folder>images</folder>
  <filename>${escapeXml(fileName)}</filename>
  <path>${escapeXml(doc.filePath)}</path>
  <source>
    <database>LR-Agent</database>
  </source>
  <size>
    <width>${doc.source.width}</width>
    <height>${doc.source.height}</height>
    <depth>3</depth>
  </size>
  <segmented>0</segmented>
${objects.join('\n')}
</annotation>
`;
    await writeText(
      path.join(annDir, `${stemFromRelative(doc.relativePath)}.xml`),
      xml,
    );
    files += 1;
  }
  return files;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function exportLabelMe(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  annotationType: string,
): Promise<number> {
  const labelmeDir = path.join(outputDir, 'labelme');
  await ensureDir(labelmeDir);
  let files = 0;

  for (const doc of docs) {
    const shapes: Record<string, unknown>[] = [];
    for (const ann of doc.annotations) {
      const label = labelName(labels, String(ann.labelId));
      if (ann.kind === 'bbox') {
        const x1 = toPixel(Number(ann.x), doc.source.width);
        const y1 = toPixel(Number(ann.y), doc.source.height);
        const x2 = toPixel(
          Number(ann.x) + Number(ann.width),
          doc.source.width,
        );
        const y2 = toPixel(
          Number(ann.y) + Number(ann.height),
          doc.source.height,
        );
        shapes.push({
          label,
          points: [
            [x1, y1],
            [x2, y2],
          ],
          group_id: null,
          shape_type: 'rectangle',
          flags: {},
        });
      } else if (ann.kind === 'polygon' && Array.isArray(ann.points)) {
        shapes.push({
          label,
          points: (ann.points as { x: number; y: number }[]).map((pt) => [
            toPixel(pt.x, doc.source.width),
            toPixel(pt.y, doc.source.height),
          ]),
          group_id: null,
          shape_type: 'polygon',
          flags: {},
        });
      } else if (ann.kind === 'rotated_bbox') {
        const cx = toPixel(Number(ann.cx), doc.source.width);
        const cy = toPixel(Number(ann.cy), doc.source.height);
        const w = toPixel(Number(ann.width), doc.source.width);
        const h = toPixel(Number(ann.height), doc.source.height);
        const corners = rotatedCornersPx(cx, cy, w, h, Number(ann.angle));
        shapes.push({
          label,
          points: corners,
          group_id: null,
          shape_type: 'polygon',
          flags: {},
        });
      } else if (ann.kind === 'point') {
        shapes.push({
          label,
          points: [
            [
              toPixel(Number(ann.x), doc.source.width),
              toPixel(Number(ann.y), doc.source.height),
            ],
          ],
          group_id: null,
          shape_type: 'point',
          flags: {},
        });
      } else if (ann.kind === 'pose' && Array.isArray(ann.keypoints)) {
        (ann.keypoints as { x: number; y: number; visibility: number }[]).forEach(
          (kp, idx) => {
            if (kp.visibility === 0) return;
            shapes.push({
              label: `${label}_kpt${idx}`,
              points: [
                [
                  toPixel(kp.x, doc.source.width),
                  toPixel(kp.y, doc.source.height),
                ],
              ],
              group_id: ann.id,
              shape_type: 'point',
              flags: { visibility: kp.visibility },
            });
          },
        );
      }
    }

    if (shapes.length === 0 && annotationType !== 'bbox') continue;

    await writeJson(
      path.join(labelmeDir, `${stemFromRelative(doc.relativePath)}.json`),
      {
        version: '5.0.1',
        flags: {},
        shapes,
        imagePath: path.posix.basename(doc.filePath),
        imageData: null,
        imageHeight: doc.source.height,
        imageWidth: doc.source.width,
      },
    );
    files += 1;
  }
  return files;
}

async function exportBboxCsv(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  mode: AnnotationExportOptions['coordinateMode'],
): Promise<number> {
  const lines = ['image,class,x,y,width,height'];
  for (const doc of docs) {
    for (const ann of doc.annotations) {
      if (ann.kind !== 'bbox') continue;
      const [x, y] = fmtCoordPair(
        Number(ann.x),
        Number(ann.y),
        mode,
        doc.source.width,
        doc.source.height,
      );
      const w =
        mode === 'normalized'
          ? Number(ann.width)
          : toPixel(Number(ann.width), doc.source.width);
      const h =
        mode === 'normalized'
          ? Number(ann.height)
          : toPixel(Number(ann.height), doc.source.height);
      lines.push(
        `${JSON.stringify(doc.filePath)},${JSON.stringify(labelName(labels, String(ann.labelId)))},${x},${y},${w},${h}`,
      );
    }
  }
  await writeText(path.join(outputDir, 'annotations.csv'), lines.join('\n'));
  return 1;
}

async function exportPolygonCoco(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  projectName: string,
): Promise<number> {
  const images: Record<string, unknown>[] = [];
  const annotations: Record<string, unknown>[] = [];
  let annId = 1;

  docs.forEach((doc, imgIdx) => {
    const imageId = imgIdx + 1;
    images.push({
      id: imageId,
      file_name: doc.filePath.replace(/\\/g, '/'),
      width: doc.source.width,
      height: doc.source.height,
    });
    for (const ann of doc.annotations) {
      if (ann.kind !== 'polygon' || !Array.isArray(ann.points)) continue;
      const pts = ann.points as { x: number; y: number }[];
      const flat = pts.flatMap((pt) => [
        toPixel(pt.x, doc.source.width),
        toPixel(pt.y, doc.source.height),
      ]);
      const xs = pts.map((pt) => toPixel(pt.x, doc.source.width));
      const ys = pts.map((pt) => toPixel(pt.y, doc.source.height));
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs);
      const maxY = Math.max(...ys);
      annotations.push({
        id: annId++,
        image_id: imageId,
        category_id: labelIndex(labels, String(ann.labelId)) + 1,
        segmentation: [flat],
        bbox: [minX, minY, maxX - minX, maxY - minY],
        area: (maxX - minX) * (maxY - minY),
        iscrowd: 0,
      });
    }
  });

  await writeJson(path.join(outputDir, 'instances.json'), {
    info: { description: projectName, version: '1.0', contributor: 'LR-Agent' },
    licenses: [],
    images,
    annotations,
    categories: labels.map((l, i) => ({
      id: i + 1,
      name: l.name,
      supercategory: 'object',
    })),
  });
  return 1;
}

async function exportYoloSeg(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
): Promise<number> {
  const labelsDir = path.join(outputDir, 'labels');
  await ensureDir(labelsDir);
  let files = 0;

  for (const doc of docs) {
    const lines: string[] = [];
    for (const ann of doc.annotations) {
      if (ann.kind !== 'polygon' || !Array.isArray(ann.points)) continue;
      const cls = labelIndex(labels, String(ann.labelId));
      const coords = (ann.points as { x: number; y: number }[])
        .flatMap((pt) => [
          clamp01(pt.x).toFixed(6),
          clamp01(pt.y).toFixed(6),
        ])
        .join(' ');
      lines.push(`${cls} ${coords}`);
    }
    await writeText(
      path.join(labelsDir, `${stemFromRelative(doc.relativePath)}.txt`),
      lines.join('\n'),
    );
    files += 1;
  }

  const yaml = [
    `path: ${JSON.stringify(outputDir)}`,
    'train: images',
    'val: images',
    `names:`,
    ...labels.map((l, i) => `  ${i}: ${JSON.stringify(l.name)}`),
    '',
  ].join('\n');
  await writeText(path.join(outputDir, 'data.yaml'), yaml);
  files += 1;
  return files;
}

async function exportPolygonCsv(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  mode: AnnotationExportOptions['coordinateMode'],
): Promise<number> {
  const lines = ['image,class,vertex_index,x,y'];
  for (const doc of docs) {
    for (const ann of doc.annotations) {
      if (ann.kind !== 'polygon' || !Array.isArray(ann.points)) continue;
      const cls = labelName(labels, String(ann.labelId));
      (ann.points as { x: number; y: number }[]).forEach((pt, idx) => {
        const [x, y] = fmtCoordPair(
          pt.x,
          pt.y,
          mode,
          doc.source.width,
          doc.source.height,
        );
        lines.push(
          `${JSON.stringify(doc.filePath)},${JSON.stringify(cls)},${idx},${x},${y}`,
        );
      });
    }
  }
  await writeText(path.join(outputDir, 'annotations.csv'), lines.join('\n'));
  return 1;
}

async function exportYoloObb(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
): Promise<number> {
  const labelsDir = path.join(outputDir, 'labels');
  await ensureDir(labelsDir);
  let files = 0;

  for (const doc of docs) {
    const lines: string[] = [];
    for (const ann of doc.annotations) {
      if (ann.kind !== 'rotated_bbox') continue;
      const cls = labelIndex(labels, String(ann.labelId));
      const angleRad = ((Number(ann.angle) * Math.PI) / 180).toFixed(6);
      lines.push(
        `${cls} ${Number(ann.cx).toFixed(6)} ${Number(ann.cy).toFixed(6)} ${Number(ann.width).toFixed(6)} ${Number(ann.height).toFixed(6)} ${angleRad}`,
      );
    }
    await writeText(
      path.join(labelsDir, `${stemFromRelative(doc.relativePath)}.txt`),
      lines.join('\n'),
    );
    files += 1;
  }

  const yaml = [
    `path: ${JSON.stringify(outputDir)}`,
    'train: images',
    'val: images',
    `names:`,
    ...labels.map((l, i) => `  ${i}: ${JSON.stringify(l.name)}`),
    '',
  ].join('\n');
  await writeText(path.join(outputDir, 'data.yaml'), yaml);
  files += 1;
  return files;
}

async function exportDota(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
): Promise<number> {
  const labelDir = path.join(outputDir, 'labelTxt');
  await ensureDir(labelDir);
  let files = 0;

  for (const doc of docs) {
    const lines: string[] = [];
    for (const ann of doc.annotations) {
      if (ann.kind !== 'rotated_bbox') continue;
      const cx = toPixel(Number(ann.cx), doc.source.width);
      const cy = toPixel(Number(ann.cy), doc.source.height);
      const w = toPixel(Number(ann.width), doc.source.width);
      const h = toPixel(Number(ann.height), doc.source.height);
      const corners = rotatedCornersPx(cx, cy, w, h, Number(ann.angle));
      const flat = corners.flatMap(([x, y]) => [x, y]).join(' ');
      lines.push(`${flat} ${labelName(labels, String(ann.labelId))} 0`);
    }
    await writeText(
      path.join(labelDir, `${stemFromRelative(doc.relativePath)}.txt`),
      lines.join('\n'),
    );
    files += 1;
  }
  return files;
}

async function exportRotatedCsv(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  mode: AnnotationExportOptions['coordinateMode'],
): Promise<number> {
  const lines = ['image,class,cx,cy,width,height,angle_deg'];
  for (const doc of docs) {
    for (const ann of doc.annotations) {
      if (ann.kind !== 'rotated_bbox') continue;
      const [cx, cy] = fmtCoordPair(
        Number(ann.cx),
        Number(ann.cy),
        mode,
        doc.source.width,
        doc.source.height,
      );
      const w =
        mode === 'normalized'
          ? Number(ann.width)
          : toPixel(Number(ann.width), doc.source.width);
      const h =
        mode === 'normalized'
          ? Number(ann.height)
          : toPixel(Number(ann.height), doc.source.height);
      lines.push(
        `${JSON.stringify(doc.filePath)},${JSON.stringify(labelName(labels, String(ann.labelId)))},${cx},${cy},${w},${h},${Number(ann.angle)}`,
      );
    }
  }
  await writeText(path.join(outputDir, 'annotations.csv'), lines.join('\n'));
  return 1;
}

async function exportKeypointCoco(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  projectName: string,
  templates: KeypointTemplateExportMeta[] | undefined,
): Promise<number> {
  const images: Record<string, unknown>[] = [];
  const annotations: Record<string, unknown>[] = [];
  const categoryMap = new Map<string, number>();
  const categories: Record<string, unknown>[] = [];
  let annId = 1;

  const ensureCategory = (
    labelId: string,
    templateId?: string,
  ): number => {
    const key = templateId ? `${labelId}:${templateId}` : labelId;
    if (categoryMap.has(key)) return categoryMap.get(key)!;
    const catId = categoryMap.size + 1;
    categoryMap.set(key, catId);
    const template = templateId
      ? getTemplateMeta(templateId, templates)
      : undefined;
    categories.push({
      id: catId,
      name: template
        ? `${labelName(labels, labelId)}_${template.name}`
        : labelName(labels, labelId),
      supercategory: 'person',
      keypoints: template?.keypoints.map((k) => k.name) ?? [],
      skeleton: [],
    });
    return catId;
  };

  docs.forEach((doc, imgIdx) => {
    const imageId = imgIdx + 1;
    images.push({
      id: imageId,
      file_name: doc.filePath.replace(/\\/g, '/'),
      width: doc.source.width,
      height: doc.source.height,
    });

    for (const ann of doc.annotations) {
      if (ann.kind === 'pose' && Array.isArray(ann.keypoints)) {
        const kpts = ann.keypoints as {
          x: number;
          y: number;
          visibility: number;
        }[];
        const flat = kpts.flatMap((kp) => [
          toPixel(kp.x, doc.source.width),
          toPixel(kp.y, doc.source.height),
          kp.visibility,
        ]);
        const numKeypoints = kpts.filter((kp) => kp.visibility > 0).length;
        const bbox = axisAlignedBboxFromKeypoints(
          kpts,
          doc.source.width,
          doc.source.height,
        );
        const catId = ensureCategory(
          String(ann.labelId),
          String(ann.templateId),
        );
        annotations.push({
          id: annId++,
          image_id: imageId,
          category_id: catId,
          keypoints: flat,
          num_keypoints: numKeypoints,
          bbox,
          area: bbox[2] * bbox[3],
          iscrowd: 0,
        });
      } else if (ann.kind === 'point') {
        const catId = ensureCategory(String(ann.labelId));
        const x = toPixel(Number(ann.x), doc.source.width);
        const y = toPixel(Number(ann.y), doc.source.height);
        annotations.push({
          id: annId++,
          image_id: imageId,
          category_id: catId,
          keypoints: [x, y, 2],
          num_keypoints: 1,
          bbox: [x - 1, y - 1, 2, 2],
          area: 4,
          iscrowd: 0,
        });
      }
    }
  });

  await writeJson(path.join(outputDir, 'keypoints.json'), {
    info: { description: projectName, version: '1.0', contributor: 'LR-Agent' },
    licenses: [],
    images,
    annotations,
    categories,
  });
  return 1;
}

async function exportYoloPose(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
): Promise<number> {
  const labelsDir = path.join(outputDir, 'labels');
  await ensureDir(labelsDir);
  let files = 0;

  for (const doc of docs) {
    const lines: string[] = [];
    for (const ann of doc.annotations) {
      if (ann.kind !== 'pose' || !Array.isArray(ann.keypoints)) continue;
      const kpts = ann.keypoints as {
        x: number;
        y: number;
        visibility: number;
      }[];
      const cls = labelIndex(labels, String(ann.labelId));
      const [bx, by, bw, bh] = axisAlignedBboxFromKeypoints(
        kpts,
        doc.source.width,
        doc.source.height,
      );
      const cx = (bx + bw / 2) / doc.source.width;
      const cy = (by + bh / 2) / doc.source.height;
      const nw = bw / doc.source.width;
      const nh = bh / doc.source.height;
      const kptPart = kpts
        .flatMap((kp) => [
          clamp01(kp.x).toFixed(6),
          clamp01(kp.y).toFixed(6),
          String(kp.visibility),
        ])
        .join(' ');
      lines.push(
        `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${nw.toFixed(6)} ${nh.toFixed(6)} ${kptPart}`,
      );
    }
    if (lines.length === 0) continue;
    await writeText(
      path.join(labelsDir, `${stemFromRelative(doc.relativePath)}.txt`),
      lines.join('\n'),
    );
    files += 1;
  }

  const yaml = [
    `path: ${JSON.stringify(outputDir)}`,
    'train: images',
    'val: images',
    `names:`,
    ...labels.map((l, i) => `  ${i}: ${JSON.stringify(l.name)}`),
    'kpt_shape: [17, 3]',
    '',
  ].join('\n');
  await writeText(path.join(outputDir, 'data.yaml'), yaml);
  files += 1;
  return files;
}

async function exportKeypointCsv(
  docs: LoadedDoc[],
  labels: LabelDef[],
  outputDir: string,
  mode: AnnotationExportOptions['coordinateMode'],
): Promise<number> {
  const lines = ['image,class,kpt_index,x,y,visibility,kind'];
  for (const doc of docs) {
    for (const ann of doc.annotations) {
      if (ann.kind === 'pose' && Array.isArray(ann.keypoints)) {
        const cls = labelName(labels, String(ann.labelId));
        (ann.keypoints as { x: number; y: number; visibility: number }[]).forEach(
          (kp, idx) => {
            const [x, y] = fmtCoordPair(
              kp.x,
              kp.y,
              mode,
              doc.source.width,
              doc.source.height,
            );
            lines.push(
              `${JSON.stringify(doc.filePath)},${JSON.stringify(cls)},${idx},${x},${y},${kp.visibility},pose`,
            );
          },
        );
      } else if (ann.kind === 'point') {
        const [x, y] = fmtCoordPair(
          Number(ann.x),
          Number(ann.y),
          mode,
          doc.source.width,
          doc.source.height,
        );
        lines.push(
          `${JSON.stringify(doc.filePath)},${JSON.stringify(labelName(labels, String(ann.labelId)))},0,${x},${y},2,point`,
        );
      }
    }
  }
  await writeText(path.join(outputDir, 'annotations.csv'), lines.join('\n'));
  return 1;
}

export async function runAnnotationExport(
  request: AnnotationExportRequest,
): Promise<AnnotationExportResult> {
  const { project, options } = request;
  const projectDir = project.directoryPath;
  const labels = project.labels;

  try {
    await ensureDir(options.outputDir);

    const rawDocs = await loadAllAnnotationDocs(projectDir);
    const docs = parseLoadedDocs(rawDocs, options.includeEmptyImages);

    if (docs.length === 0) {
      return {
        success: false,
        outputDir: options.outputDir,
        filesWritten: 0,
        imageCount: 0,
        annotationCount: 0,
        message: '没有可导出的标注数据',
        error: '索引中无有效标注文档，请先打开并保存至少一张图片的标注',
      };
    }

    const annotationCount = docs.reduce(
      (n, d) => n + d.annotations.length,
      0,
    );
    const { format, coordinateMode } = options;
    const { docs: trainingDocs, skippedUnlabeled } =
      format === 'lr_agent'
        ? { docs, skippedUnlabeled: 0 }
        : filterDocsForTrainingExport(docs);
    let filesWritten = 0;
    const annType = project.annotationType;

    switch (format) {
      case 'lr_agent':
        filesWritten = await exportNative(projectDir, options.outputDir, docs);
        break;
      case 'yolo':
        if (annType !== 'bbox') throw new Error('YOLO 检测格式仅适用于矩形框任务');
        filesWritten = await exportBboxYolo(trainingDocs, labels, options.outputDir);
        break;
      case 'coco':
        if (annType === 'bbox') {
          filesWritten = await exportBboxCoco(
            trainingDocs,
            labels,
            options.outputDir,
            project.name,
          );
        } else if (annType === 'polygon') {
          filesWritten = await exportPolygonCoco(
            trainingDocs,
            labels,
            options.outputDir,
            project.name,
          );
        } else if (annType === 'keypoint') {
          filesWritten = await exportKeypointCoco(
            trainingDocs,
            labels,
            options.outputDir,
            project.name,
            request.keypointTemplates,
          );
        } else {
          throw new Error('当前任务类型不支持 COCO 格式');
        }
        break;
      case 'voc':
        filesWritten = await exportBboxVoc(trainingDocs, labels, options.outputDir);
        break;
      case 'labelme':
        filesWritten = await exportLabelMe(
          trainingDocs,
          labels,
          options.outputDir,
          annType,
        );
        break;
      case 'csv':
        if (annType === 'bbox') {
          filesWritten = await exportBboxCsv(
            trainingDocs,
            labels,
            options.outputDir,
            coordinateMode,
          );
        } else if (annType === 'polygon') {
          filesWritten = await exportPolygonCsv(
            trainingDocs,
            labels,
            options.outputDir,
            coordinateMode,
          );
        } else if (annType === 'keypoint') {
          filesWritten = await exportKeypointCsv(
            trainingDocs,
            labels,
            options.outputDir,
            coordinateMode,
          );
        } else if (annType === 'rotated_bbox') {
          filesWritten = await exportRotatedCsv(
            trainingDocs,
            labels,
            options.outputDir,
            coordinateMode,
          );
        } else {
          throw new Error('当前任务类型不支持 CSV 格式');
        }
        break;
      case 'yolo_seg':
        filesWritten = await exportYoloSeg(trainingDocs, labels, options.outputDir);
        break;
      case 'yolo_obb':
        filesWritten = await exportYoloObb(trainingDocs, labels, options.outputDir);
        break;
      case 'dota':
        filesWritten = await exportDota(trainingDocs, labels, options.outputDir);
        break;
      case 'yolo_pose':
        filesWritten = await exportYoloPose(trainingDocs, labels, options.outputDir);
        break;
      default:
        throw new Error(`未知导出格式: ${format}`);
    }

    const exportMessage =
      skippedUnlabeled > 0
        ? `已导出 ${docs.length} 张图片、${annotationCount} 条标注，共 ${filesWritten} 个文件（跳过 ${skippedUnlabeled} 条未标注）`
        : `已导出 ${docs.length} 张图片、${annotationCount} 条标注，共 ${filesWritten} 个文件`;

    return {
      success: true,
      outputDir: options.outputDir,
      filesWritten,
      imageCount: docs.length,
      annotationCount,
      skippedUnlabeledCount:
        skippedUnlabeled > 0 ? skippedUnlabeled : undefined,
      message: exportMessage,
    };
  } catch (err) {
    return {
      success: false,
      outputDir: options.outputDir,
      filesWritten: 0,
      imageCount: 0,
      annotationCount: 0,
      message: '导出失败',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

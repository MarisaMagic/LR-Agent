/**
 * 快照 → COCO：把 `experiments/runs/<run>/<stage>/` 的标注快照转成 COCO `instances.json`，
 * 用于 `exp:eval` 评测，无需在应用 UI 里手动导出。
 *
 * 与 UI 导出的差异：
 *   - 图片 `file_name` 用 basename，且按文件名排序编号（与 GT 天然对齐；
 *     `eval_bbox.py` 亦会按文件名重映射，双保险）；
 *   - 只导出 `kind === 'bbox'` 且标签有效的标注；无标签/未知标签会计数并在摘要中提示。
 *
 * 用法：
 *   node scripts/experiments/snapshotToCoco.mjs \
 *     --snapshot experiments/runs/A/final \
 *     --out experiments/results/A/instances.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = { snapshot: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot') options.snapshot = path.resolve(argv[++i]);
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  if (!options.snapshot) {
    console.error(
      '用法: node scripts/experiments/snapshotToCoco.mjs --snapshot <快照目录> [--out <instances.json>]',
    );
    process.exit(2);
  }
  if (!options.out) {
    // 默认 experiments/results/<run>/instances.json（快照目录的上一级是 run 标签）
    const runName = path.basename(path.dirname(options.snapshot));
    options.out = path.join(root, 'experiments', 'results', runName, 'instances.json');
  }
  return options;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toPixel(value, dimension) {
  return Math.round(clamp01(Number(value)) * dimension * 100) / 100;
}

async function readDoc(snapshotDir, entry) {
  const docPath = path.join(
    snapshotDir,
    'annotations',
    'files',
    `${entry.fileKey}.json`,
  );
  if (!(await exists(docPath))) return null;
  try {
    return JSON.parse(await fs.readFile(docPath, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshotDir = options.snapshot;

  const projectPath = path.join(snapshotDir, 'project.json');
  const indexPath = path.join(snapshotDir, 'annotations', 'index.json');
  if (!(await exists(indexPath))) {
    throw new Error(`未找到 ${indexPath}（快照目录是否传错？）`);
  }
  const labels = (await exists(projectPath))
    ? (JSON.parse(await fs.readFile(projectPath, 'utf8')).labels ?? [])
    : [];
  if (labels.length === 0) {
    throw new Error(`快照缺少有效标签定义：${projectPath}`);
  }
  const labelNameById = new Map(labels.map((l) => [l.id, l.name]));

  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const entries = Object.values(index.files ?? {});

  const images = [];
  const annotations = [];
  let skippedUnlabeled = 0;
  let unknownLabels = 0;
  let skippedNoSource = 0;
  let annId = 1;

  for (const entry of entries) {
    const doc = await readDoc(snapshotDir, entry);
    if (!doc) continue;
    const width = Number(doc.source?.width);
    const height = Number(doc.source?.height);
    if (!(width > 0) || !(height > 0)) {
      skippedNoSource += 1;
      continue;
    }

    const fileName = path.basename(entry.relativePath);
    const imageId = images.length + 1;
    images.push({
      id: imageId,
      file_name: fileName,
      width,
      height,
    });

    for (const ann of doc.annotations ?? []) {
      if (ann.kind !== 'bbox') continue;
      if (!ann.labelId) {
        skippedUnlabeled += 1;
        continue;
      }
      const name = labelNameById.get(ann.labelId);
      if (!name) {
        unknownLabels += 1;
        continue;
      }
      const categoryIndex = labels.findIndex((l) => l.id === ann.labelId);
      annotations.push({
        id: annId,
        image_id: imageId,
        category_id: categoryIndex + 1,
        bbox: [
          toPixel(ann.x, width),
          toPixel(ann.y, height),
          toPixel(ann.width, width),
          toPixel(ann.height, height),
        ],
        area:
          toPixel(ann.width, width) * toPixel(ann.height, height),
        iscrowd: 0,
      });
      annId += 1;
    }
  }

  images.sort((a, b) => a.file_name.localeCompare(b.file_name));
  const idMap = new Map(images.map((image, index) => [image.id, index + 1]));
  for (const image of images) image.id = idMap.get(image.id);
  for (const ann of annotations) ann.image_id = idMap.get(ann.image_id);

  const coco = {
    info: {
      description: `LR-Agent snapshot export (${path.basename(snapshotDir)})`,
      version: '1.0',
      year: new Date().getFullYear(),
      contributor: 'LR-Agent',
      date_created: new Date().toISOString(),
    },
    licenses: [],
    images,
    annotations,
    categories: labels.map((l, index) => ({
      id: index + 1,
      name: l.name,
      supercategory: 'object',
    })),
  };

  await fs.mkdir(path.dirname(options.out), { recursive: true });
  await fs.writeFile(options.out, JSON.stringify(coco, null, 2));

  console.log(`快照：${snapshotDir}`);
  console.log(`输出：${options.out}`);
  console.log(
    `图片 ${images.length} 张，标注 ${annotations.length} 条` +
      `（跳过无标签 ${skippedUnlabeled}，未知标签 ${unknownLabels}` +
      `${skippedNoSource > 0 ? `，缺图片尺寸 ${skippedNoSource}` : ''}）`,
  );
  if (annotations.length === 0) {
    console.warn('警告：没有可导出的标注');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

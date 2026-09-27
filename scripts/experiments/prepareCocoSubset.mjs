/**
 * 实验数据准备：从 COCO val2017 生成 bbox 实验用子集与三个任务目录。
 *
 * 产物（默认 `experiments/data/`）：
 *   source/annotations_val2017.json  COCO 官方标注（缓存）
 *   source/images/*.jpg              所选 10 张图
 *   gt/instances_project.json        全量 GT（项目标签空间，COCO 格式）
 *   gt/instances_{A,B,C}.json        拆分设计下的各条件子集 GT（同图设计不生成）
 *   gt/label_map.json                COCO 类别 ↔ 项目标签映射
 *   manifest.json                    抽样结果 + design + assignments
 *   tasks/{A,B,C}/images/            三个任务目录
 *
 * 规则（见 docs/experiments/bbox-eval-protocol.md §3）：
 *   - GT 框全部落在标签池内、无 iscrowd；
 *   - 轻量化抽样：以 1–5 框为主（70%）、6–15 框为辅（30%），不含 16–30 框，固定随机种子；
 *   - 默认同图配对（design=same）：三个任务使用同一套图片、每条件各标一遍；
 *     `--design split` 则按分层均衡拆分给 A/B/C（每张只标一次）；
 *   - 仅下载所选图片。
 *
 * 用法：
 *   node scripts/experiments/prepareCocoSubset.mjs
 *   node scripts/experiments/prepareCocoSubset.mjs --out experiments/data --count 30
 *   node scripts/experiments/prepareCocoSubset.mjs --relayout
 *   node scripts/experiments/prepareCocoSubset.mjs --annotations <instances_val2017.json> --no-images
 *   node scripts/experiments/prepareCocoSubset.mjs --help
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const COCO_ANNOTATIONS_URL =
  'https://images.cocodataset.org/annotations/annotations_trainval2017.zip';
/** 官方域名的同对象直链：部分地区官方域名 TLS 被干扰时可用（如证书 hostname 不匹配）。 */
const COCO_ANNOTATIONS_FALLBACK_URL =
  'https://s3.amazonaws.com/images.cocodataset.org/annotations/annotations_trainval2017.zip';
const COCO_IMAGE_BASE = 'https://images.cocodataset.org/val2017';
const COCO_IMAGE_FALLBACK_BASE =
  'https://s3.amazonaws.com/images.cocodataset.org/val2017';
/** 单文件下载中断后的最大续传尝试次数。 */
const DOWNLOAD_MAX_ATTEMPTS = 4;

/** 标签池：COCO 类别 → 项目中文标签（与协议 §3 一致）。 */
const LABEL_POOL = [
  { cocoName: 'person', projectName: '人', color: '#F44336' },
  { cocoName: 'bicycle', projectName: '自行车', color: '#E91E63' },
  { cocoName: 'car', projectName: '汽车', color: '#9C27B0' },
  { cocoName: 'motorcycle', projectName: '摩托车', color: '#673AB7' },
  { cocoName: 'bus', projectName: '公交车', color: '#2196F3' },
  { cocoName: 'truck', projectName: '卡车', color: '#03A9F4' },
  { cocoName: 'cat', projectName: '猫', color: '#009688' },
  { cocoName: 'dog', projectName: '狗', color: '#4CAF50' },
  { cocoName: 'bird', projectName: '鸟', color: '#8BC34A' },
  { cocoName: 'horse', projectName: '马', color: '#CDDC39' },
  { cocoName: 'sheep', projectName: '羊', color: '#FFC107' },
  { cocoName: 'cow', projectName: '牛', color: '#FF9800' },
];

/**
 * 抽样分层（轻量化）：以 1–5 框为主、6–15 框为辅，不含 16–30 框。
 * `weight` 为按 `--count` 分配名额的比例。
 */
const STRATA = [
  { name: '1-5', min: 1, max: 5, weight: 0.7 },
  { name: '6-15', min: 6, max: 15, weight: 0.3 },
];

function printHelp() {
  console.log(`用法: node scripts/experiments/prepareCocoSubset.mjs [options]

选项:
  --out <dir>         输出根目录（默认 experiments/data）
  --count <n>         抽样图片数（默认 10，轻量化）
  --design <same|split>  同图配对（默认 same：三任务同图、各标一遍）
                         或一次性拆分（split：A/B/C 各分一部分）
  --seed <n>          随机种子（默认 20260927）
  --annotations <p>   本地 instances_val2017.json（跳过下载/解压）
  --annotations-url <u>  指定注解 zip 下载地址（默认官方域名，失败自动回退 S3 直链）
  --no-images         不下载图片、不创建任务目录（离线/自测用）
  --relayout          仅用现有源图重建任务目录（沿用 manifest 的 design，不重新下载）
  --force             覆盖已有产物（默认存在即报错退出）
  --help              显示帮助
`);
}

function parseArgs(argv) {
  const options = {
    out: path.join(root, 'experiments', 'data'),
    count: 10,
    design: 'same',
    seed: 20260927,
    annotations: null,
    annotationsUrl: null,
    images: true,
    relayout: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else if (arg === '--count') options.count = Number(argv[++i]);
    else if (arg === '--design') options.design = String(argv[++i] ?? '').trim();
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else if (arg === '--annotations') options.annotations = path.resolve(argv[++i]);
    else if (arg === '--annotations-url') options.annotationsUrl = String(argv[++i] ?? '').trim();
    else if (arg === '--no-images') options.images = false;
    else if (arg === '--relayout') options.relayout = true;
    else if (arg === '--force') options.force = true;
    else {
      console.error(`未知参数: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.count) || options.count < 6) {
    console.error('--count 必须是 ≥6 的数字');
    process.exit(2);
  }
  if (!['same', 'split'].includes(options.design)) {
    console.error('--design 必须是 same 或 split');
    process.exit(2);
  }
  return options;
}

/** 可复现 PRNG（mulberry32）。 */
function createRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * 流式下载到 `<dest>.part`，中断后可带 `Range` 续传，结束后校验字节数并改名到 `dest`。
 *
 * - 服务器不支持 Range（返回 200）时自动从头重下；
 * - `expectedBytes` 存在且最终大小不符时抛出（调用方可重试）；
 * - 不把大文件读进内存。
 */
export async function downloadWithResume(url, dest, options = {}) {
  const partPath = `${dest}.part`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const maxAttempts = options.maxAttempts ?? DOWNLOAD_MAX_ATTEMPTS;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let start = 0;
    if (await exists(partPath)) {
      start = (await fs.stat(partPath)).size;
    }

    try {
      const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15 * 60_000),
      });

      if (start > 0 && res.status === 200) {
        // 服务器忽略了 Range：已有分片不可用，从头开始
        start = 0;
      } else if (
        res.status === 416 &&
        options.expectedBytes &&
        start === options.expectedBytes
      ) {
        // 分片已完整，只是上次改名失败：直接落位
        await fs.rm(dest, { force: true });
        await fs.rename(partPath, dest);
        return { bytes: start, url, resumed: true };
      } else if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.body) throw new Error('响应没有 body');

      const handle = await fs.open(partPath, start > 0 ? 'a' : 'w');
      let written = start;
      let lastLogged = start;
      try {
        for await (const chunk of res.body) {
          await handle.write(chunk);
          written += chunk.length;
          if (written - lastLogged >= 10 * 1024 * 1024) {
            lastLogged = written;
            const totalText = options.expectedBytes
              ? ` / ${formatBytes(options.expectedBytes)}`
              : '';
            console.log(`  已下载 ${formatBytes(written)}${totalText}`);
          }
        }
      } finally {
        await handle.close();
      }

      if (options.expectedBytes && written !== options.expectedBytes) {
        throw new Error(
          `字节数不符：期望 ${options.expectedBytes}，实际 ${written}（可重试续传）`,
        );
      }

      await fs.rm(dest, { force: true });
      await fs.rename(partPath, dest);
      return { bytes: written, url, resumed: start > 0 };
    } catch (err) {
      lastError = err;
      if (!options.quiet) {
        console.warn(
          `  下载失败（第 ${attempt}/${maxAttempts} 次）：${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }
  throw lastError ?? new Error('下载失败');
}

/**
 * 依次尝试多个同对象下载源；某个源失败则切换到下一个。
 * 单源内部由 `downloadWithResume` 负责续传与重试。
 */
export async function downloadFromSources(urls, dest, options = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      const result = await downloadWithResume(url, dest, options);
      if (url !== urls[0] && !options.quiet) {
        console.log(`  已回退到备用源：${url}`);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (!options.quiet) {
        console.warn(
          `  源失败：${url} — ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  throw lastError ?? new Error('所有下载源均失败');
}

/** 解压出的中间目录（含 train 大文件，约 800MB）；成功复制后清理，zip 保留。 */
async function cleanupExtracted(extractDir) {
  if (!(await exists(extractDir))) return;
  await fs.rm(extractDir, { recursive: true, force: true });
  console.log('已清理解压中间目录（保留 .cache 中的 zip）');
}

/** 解压结果看起来完整（val 注解 >5MB）时可跳过重复解压。 */
async function extractedLooksUsable(extracted) {
  try {
    const stats = await fs.stat(extracted);
    return stats.isFile() && stats.size > 5 * 1024 * 1024;
  } catch {
    return false;
  }
}

async function resolveAnnotationsFile(options) {
  if (options.annotations) {
    if (!(await exists(options.annotations))) {
      throw new Error(`标注文件不存在: ${options.annotations}`);
    }
    return { path: options.annotations, source: 'local' };
  }

  const cacheDir = path.join(options.out, '.cache');
  const extractDir = path.join(cacheDir, 'extracted');
  const extracted = path.join(extractDir, 'annotations', 'instances_val2017.json');
  const cached = path.join(options.out, 'source', 'annotations_val2017.json');
  if (await exists(cached)) {
    await cleanupExtracted(extractDir);
    return { path: cached, source: 'cache' };
  }
  const zipPath = path.join(cacheDir, 'annotations_trainval2017.zip');
  await fs.mkdir(cacheDir, { recursive: true });

  if (!(await exists(zipPath))) {
    const sources = options.annotationsUrl
      ? [options.annotationsUrl]
      : [COCO_ANNOTATIONS_URL, COCO_ANNOTATIONS_FALLBACK_URL];
    console.log('下载 COCO 标注（约 240MB，支持断点续传）…');
    const downloaded = await downloadFromSources(sources, zipPath, {
      expectedBytes: 252_907_541,
    });
    console.log(`  完成：${formatBytes(downloaded.bytes)}（源：${downloaded.url}）`);
  }

  if (await extractedLooksUsable(extracted)) {
    console.log(`复用已解压的 ${path.basename(extracted)}（跳过解压）`);
  } else {
    console.log('解压 instances_val2017.json ...');
    await fs.mkdir(extractDir, { recursive: true });
    try {
      if (process.platform === 'win32') {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
          ],
          { stdio: 'inherit' },
        );
      } else {
        execFileSync('unzip', ['-o', zipPath, '-d', extractDir], { stdio: 'inherit' });
      }
    } catch (err) {
      throw new Error(
        `解压失败（${err instanceof Error ? err.message : err}）。` +
          '可删除 experiments/data/.cache 后重试下载；或手动下载 annotations_trainval2017.zip 解压，' +
          '把 instances_val2017.json 放到 experiments/data/source/annotations_val2017.json。',
      );
    }
  }

  if (!(await exists(extracted))) {
    throw new Error(
      `解压后未找到 ${extracted}。可删除 experiments/data/.cache 后重试；` +
        '或手动下载 annotations_trainval2017.zip 解压后，把 instances_val2017.json 放到 ' +
        'experiments/data/source/annotations_val2017.json。',
    );
  }

  try {
    await fs.mkdir(path.dirname(cached), { recursive: true });
    await fs.copyFile(extracted, cached);
  } catch (err) {
    throw new Error(
      `复制标注文件失败（${err instanceof Error ? err.message : err}）。` +
        `请确认目录可写：${path.dirname(cached)}`,
    );
  }
  await cleanupExtracted(extractDir);
  return { path: cached, source: 'download' };
}

function selectImages(annotations, options) {
  const poolByName = new Map(LABEL_POOL.map((entry, index) => [entry.cocoName, index]));
  const categoryNameById = new Map(
    annotations.categories.map((c) => [c.id, c.name]),
  );

  const annsByImage = new Map();
  for (const ann of annotations.annotations) {
    if (!annsByImage.has(ann.image_id)) annsByImage.set(ann.image_id, []);
    annsByImage.get(ann.image_id).push(ann);
  }

  const candidates = [];
  for (const image of annotations.images) {
    const anns = annsByImage.get(image.id) ?? [];
    if (anns.length === 0) continue;
    if (anns.some((a) => a.iscrowd === 1)) continue;
    if (anns.length > STRATA[STRATA.length - 1].max) continue;

    const mapped = [];
    let invalid = false;
    for (const ann of anns) {
      const cocoName = categoryNameById.get(ann.category_id);
      const poolIndex = cocoName != null ? poolByName.get(cocoName) : undefined;
      if (poolIndex === undefined) {
        invalid = true;
        break;
      }
      const [x, y, w, h] = ann.bbox;
      if (!(w > 0) || !(h > 0)) {
        invalid = true;
        break;
      }
      mapped.push({ ann, poolIndex });
    }
    if (invalid) continue;

    const stratumIndex = STRATA.findIndex(
      (s) => anns.length >= s.min && anns.length <= s.max,
    );
    if (stratumIndex < 0) continue;

    candidates.push({
      image,
      anns: mapped,
      boxCount: anns.length,
      stratum: STRATA[stratumIndex].name,
      stratumIndex,
    });
  }

  const rng = createRng(options.seed);
  const byStratum = new Map();
  for (const candidate of candidates) {
    const list = byStratum.get(candidate.stratumIndex) ?? [];
    list.push(candidate);
    byStratum.set(candidate.stratumIndex, list);
  }

  const targets = [];
  let assignedCount = 0;
  for (let s = 0; s < STRATA.length; s += 1) {
    const isLast = s === STRATA.length - 1;
    const weight = STRATA[s].weight ?? 1 / STRATA.length;
    const target = isLast
      ? options.count - assignedCount
      : Math.floor(options.count * weight);
    targets.push(target);
    assignedCount += target;
  }
  const selected = [];
  const leftovers = [];
  for (let s = 0; s < STRATA.length; s += 1) {
    const shuffled = shuffle(byStratum.get(s) ?? [], rng);
    selected.push(...shuffled.slice(0, targets[s]));
    leftovers.push(...shuffled.slice(targets[s]));
  }
  if (selected.length < options.count) {
    for (const candidate of shuffle(leftovers, rng)) {
      if (selected.length >= options.count) break;
      selected.push(candidate);
    }
  }
  if (selected.length < options.count) {
    throw new Error(
      `符合规则的图片不足：需要 ${options.count}，找到 ${selected.length}（可调小 --count）`,
    );
  }

  selected.sort((a, b) => a.image.file_name.localeCompare(b.image.file_name));
  return { selected, totalCandidates: candidates.length };
}

function buildGt(selected) {
  const categories = LABEL_POOL.map((entry, index) => ({
    id: index + 1,
    name: entry.projectName,
  }));
  const images = [];
  const annotations = [];
  let annId = 1;

  selected.forEach((candidate, imageIndex) => {
    const imageId = imageIndex + 1;
    images.push({
      id: imageId,
      file_name: candidate.image.file_name,
      width: candidate.image.width,
      height: candidate.image.height,
      coco_id: candidate.image.id,
    });
    for (const { ann, poolIndex } of candidate.anns) {
      const [x, y, w, h] = ann.bbox;
      annotations.push({
        id: annId,
        image_id: imageId,
        category_id: poolIndex + 1,
        bbox: [x, y, w, h],
        area: w * h,
        iscrowd: 0,
      });
      annId += 1;
    }
  });

  return { info: { description: 'LR-Agent bbox eval GT (COCO val2017 subset)' }, categories, images, annotations };
}

/**
 * 一次性设计：把 40 张图按分层均衡地分给 A/B/C（每张只标一次）。
 *
 * 确定性算法：按 (分层, 框数, 文件名) 排序后全局轮转 A→B→C，
 * 使各条件总数（约 14/13/13）与各分层内分布都接近均衡。
 */
function buildAssignments(images, design = 'same') {
  const conditions = ['A', 'B', 'C'];
  if (design === 'same') {
    // 同图配对：三个任务用同一套图片，每个条件各标一遍
    const files = images.map((image) => image.fileName);
    return { A: [...files], B: [...files], C: [...files] };
  }
  const sorted = [...images].sort(
    (a, b) =>
      a.stratumIndex - b.stratumIndex ||
      a.boxCount - b.boxCount ||
      a.fileName.localeCompare(b.fileName),
  );
  const assignments = { A: [], B: [], C: [] };
  sorted.forEach((image, index) => {
    assignments[conditions[index % conditions.length]].push(image.fileName);
  });
  return assignments;
}

function stratumIndexOf(stratumName) {
  return STRATA.findIndex((s) => s.name === stratumName);
}

/** 从 manifest.images 推导分配（relayout 用；与全新生成结果一致）。 */
function buildAssignmentsFromManifest(manifestImages, design = 'same') {
  return buildAssignments(
    manifestImages.map((image) => ({
      fileName: image.file_name,
      boxCount: image.box_count,
      stratumIndex: stratumIndexOf(image.stratum),
    })),
    design,
  );
}

/**
 * 各条件 GT：
 * - 拆分设计（split）为每个条件写一份只含该条件图片的 GT；
 * - 同图设计（same）三份与全量 GT 相同，直接清理旧的 per-condition 文件，评测用 `instances_project.json`。
 */
async function syncConditionGts(gt, assignments, outDir, design) {
  const gtDir = path.join(outDir, 'gt');
  await fs.mkdir(gtDir, { recursive: true });
  const conditionFiles = ['A', 'B', 'C'].map((condition) =>
    path.join(gtDir, `instances_${condition}.json`),
  );
  if (design === 'same') {
    for (const file of conditionFiles) {
      await fs.rm(file, { force: true });
    }
    return;
  }
  for (const condition of ['A', 'B', 'C']) {
    const names = new Set(assignments[condition]);
    const images = gt.images.filter((image) => names.has(image.file_name));
    const idMap = new Map(images.map((image, index) => [image.id, index + 1]));
    const annotations = gt.annotations
      .filter((ann) => idMap.has(ann.image_id))
      .map((ann, index) => ({
        ...ann,
        id: index + 1,
        image_id: idMap.get(ann.image_id),
      }));
    const coco = {
      ...gt,
      images: images.map((image) => ({ ...image, id: idMap.get(image.id) })),
      annotations,
    };
    await fs.writeFile(
      path.join(gtDir, `instances_${condition}.json`),
      JSON.stringify(coco, null, 2),
    );
  }
}

/**
 * 清理任务里已不属于本条件的「空」标注文档（重新拆分后遗留）。
 *
 * 只删除 `annotationCount === 0` 的孤儿；仍有标注的孤儿一律保留并告警，
 * 避免静默丢数据（实验开始前不存在带标注的孤儿，属安全清理）。
 */
async function pruneOrphanDocs(taskDir, assigned) {
  const annotationsDir = path.join(taskDir, '.lr-agent', 'annotations');
  const indexPath = path.join(annotationsDir, 'index.json');
  if (!(await exists(indexPath))) return;

  let index;
  try {
    index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch {
    return;
  }
  if (!index || typeof index !== 'object' || !index.files) return;

  const assignedSet = new Set(assigned);
  let removed = 0;
  let keptAnnotated = 0;
  for (const [rel, entry] of Object.entries(index.files)) {
    if (assignedSet.has(path.basename(rel))) continue;
    if ((entry.annotationCount ?? 0) > 0) {
      keptAnnotated += 1;
      continue;
    }
    await fs.rm(
      path.join(annotationsDir, 'files', `${entry.fileKey}.json`),
      { force: true },
    );
    delete index.files[rel];
    removed += 1;
  }
  if (removed === 0 && keptAnnotated === 0) return;

  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  const condition = path.basename(taskDir);
  if (removed > 0) {
    console.log(`  清理 ${condition} 的空孤儿标注文档：${removed}`);
  }
  if (keptAnnotated > 0) {
    console.warn(
      `  注意：${condition} 有 ${keptAnnotated} 个已移除图片仍带标注，未删除，请人工核对`,
    );
  }
}

/**
 * 重建任务目录：每个条件的任务里只放它分配到的图片。
 * 保留任务目录下已有的 `.lr-agent`（项目配置与标注），只重建 `images/`。
 */
async function layoutTasks(outDir, sourceImagesDir, assignments) {
  for (const condition of ['A', 'B', 'C']) {
    const taskDir = path.join(outDir, 'tasks', condition);
    const imagesDir = path.join(taskDir, 'images');
    await fs.rm(imagesDir, { recursive: true, force: true });
    await fs.mkdir(imagesDir, { recursive: true });
    for (const fileName of assignments[condition]) {
      const source = path.join(sourceImagesDir, fileName);
      if (!(await exists(source))) {
        throw new Error(`源图片缺失：${source}（可重新下载或检查 manifest）`);
      }
      await fs.copyFile(source, path.join(imagesDir, fileName));
    }
    await pruneOrphanDocs(taskDir, assignments[condition]);
    console.log(
      `tasks/${condition}/images：${assignments[condition].length} 张`,
    );
  }
}

async function relayout(options) {
  const outDir = options.out;
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!(await exists(manifestPath))) {
    throw new Error(`未找到 ${manifestPath}，请先运行 exp:prepare 生成数据`);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const sourceImagesDir = path.join(outDir, 'source', 'images');
  if (!(await exists(sourceImagesDir))) {
    throw new Error(`未找到 ${sourceImagesDir}，请先运行 exp:prepare 下载图片`);
  }
  const gtPath = path.join(outDir, 'gt', 'instances_project.json');
  if (!(await exists(gtPath))) {
    throw new Error(`未找到 ${gtPath}，请先运行 exp:prepare 生成 GT`);
  }

  const design = manifest.design === 'same-images-paired' ? 'same' : 'split';
  const assignments =
    manifest.assignments ?? buildAssignmentsFromManifest(manifest.images, design);
  manifest.assignments = assignments;
  manifest.design =
    design === 'same' ? 'same-images-paired' : 'one-shot-balanced-split';
  delete manifest.schedule;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const gt = JSON.parse(await fs.readFile(gtPath, 'utf8'));
  await syncConditionGts(gt, assignments, outDir, design);
  await layoutTasks(outDir, sourceImagesDir, assignments);

  console.log(
    `\n重建完成（${design === 'same' ? '同图配对，三任务各标一遍' : '一次性拆分'}）。下一步：`,
  );
  console.log('1. 在 LR-Agent 中创建三个任务（若已创建可复用）：');
  for (const condition of ['A', 'B', 'C']) {
    console.log(
      `   ${condition} → ${path.join(outDir, 'tasks', condition)}` +
        `（${assignments[condition].length} 张）`,
    );
  }
  console.log('2. 每个任务加入同一套中文标签：');
  console.log(`   ${LABEL_POOL.map((l) => l.projectName).join('、')}`);
  console.log('3. 按 README 运行 A / B / C 三个 run（标签 A、B、C）。');
}

async function downloadImages(selected, outDir) {
  const imagesDir = path.join(outDir, 'source', 'images');
  await fs.mkdir(imagesDir, { recursive: true });

  const queue = [...selected];
  let downloaded = 0;
  let skipped = 0;
  const usedSources = new Set();

  const worker = async () => {
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!candidate) return;
      const fileName = candidate.image.file_name;
      const dest = path.join(imagesDir, fileName);
      if (await exists(dest)) {
        skipped += 1;
        continue;
      }

      const urls = [];
      const cocoUrl = candidate.image.coco_url?.startsWith('http')
        ? candidate.image.coco_url.replace(/^http:/, 'https:')
        : null;
      if (cocoUrl) urls.push(cocoUrl);
      // 同源只留一个候选：官方域名失败时直接切 S3，避免对同一 origin 反复重试
      const seenOrigins = new Set();
      const candidates = [];
      for (const url of [...urls, `${COCO_IMAGE_BASE}/${fileName}`, `${COCO_IMAGE_FALLBACK_BASE}/${fileName}`]) {
        try {
          const origin = new URL(url).origin;
          if (seenOrigins.has(origin)) continue;
          seenOrigins.add(origin);
          candidates.push(url);
        } catch {
          // 非法 URL 忽略
        }
      }

      try {
        const result = await downloadFromSources(candidates, dest, {
          maxAttempts: 2,
          quiet: true,
        });
        usedSources.add(new URL(result.url).origin);
        downloaded += 1;
      } catch (err) {
        throw new Error(`下载失败 ${fileName}: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  // 每个 worker 串行处理队列，4 个 worker 并发；单个文件内部由 downloadFromSources 负责重试
  await Promise.all([worker(), worker(), worker(), worker()]);

  // 清理旧抽样遗留的图片（重跑 --force / 改变 --count 时保持 source/images 只含本次所选）
  const wanted = new Set(selected.map((c) => c.image.file_name));
  const stale = (
    await fs.readdir(imagesDir, { withFileTypes: true })
  ).filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith('.') &&
      !wanted.has(entry.name) &&
      /\.(jpe?g|png|webp|bmp|gif|ico)$/i.test(entry.name),
  );
  for (const entry of stale) {
    await fs.rm(path.join(imagesDir, entry.name), { force: true });
  }
  if (stale.length > 0) {
    console.log(`清理不再使用的旧图：${stale.length} 张`);
  }

  console.log(
    `图片下载完成：新增 ${downloaded}，已存在 ${skipped}${
      usedSources.size > 0 ? `（源：${[...usedSources].join(', ')}）` : ''
    }`,
  );
  return { imagesDir, sources: [...usedSources] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.out;

  if (options.relayout) {
    await relayout(options);
    return;
  }

  const marker = path.join(outDir, 'manifest.json');
  if (!options.force && (await exists(marker))) {
    console.error(`产物已存在：${marker}（如需重建请加 --force）`);
    process.exit(2);
  }

  await fs.mkdir(outDir, { recursive: true });
  const annotationsSource = await resolveAnnotationsFile(options);
  const annotations = JSON.parse(
    await fs.readFile(annotationsSource.path, 'utf8'),
  );
  console.log(
    `COCO val2017：${annotations.images.length} 张图，${annotations.annotations.length} 条标注`,
  );

  const { selected, totalCandidates } = selectImages(annotations, options);
  console.log(
    `候选（全部框在标签池内、≤15 框、无 iscrowd）：${totalCandidates}，抽样 ${selected.length}`,
  );

  const gt = buildGt(selected);
  const assignments = buildAssignments(
    selected.map((c) => ({
      fileName: c.image.file_name,
      boxCount: c.boxCount,
      stratumIndex: c.stratumIndex,
    })),
    options.design,
  );
  const labelMap = {
    labels: LABEL_POOL.map((entry, index) => ({
      index: index + 1,
      cocoName: entry.cocoName,
      projectName: entry.projectName,
      color: entry.color,
    })),
  };
  const manifest = {
    createdAt: new Date().toISOString(),
    design:
      options.design === 'same'
        ? 'same-images-paired'
        : 'one-shot-balanced-split',
    seed: options.seed,
    count: selected.length,
    labelPool: LABEL_POOL.map((entry) => entry.projectName),
    downloadSources: { annotations: annotationsSource.source, images: [] },
    strata: STRATA.map((s) => ({
      name: s.name,
      count: selected.filter((c) => c.stratum === s.name).length,
    })),
    images: selected.map((c) => ({
      file_name: c.image.file_name,
      coco_id: c.image.id,
      width: c.image.width,
      height: c.image.height,
      box_count: c.boxCount,
      stratum: c.stratum,
    })),
    assignments,
  };

  await fs.mkdir(path.join(outDir, 'gt'), { recursive: true });
  await fs.writeFile(
    path.join(outDir, 'gt', 'instances_project.json'),
    JSON.stringify(gt, null, 2),
  );
  await fs.writeFile(
    path.join(outDir, 'gt', 'label_map.json'),
    JSON.stringify(labelMap, null, 2),
  );
  await fs.writeFile(marker, JSON.stringify(manifest, null, 2));
  await syncConditionGts(gt, assignments, outDir, options.design);

  if (options.images) {
    const downloaded = await downloadImages(selected, outDir);
    manifest.downloadSources.images = downloaded.sources;
    await fs.writeFile(marker, JSON.stringify(manifest, null, 2));
    await layoutTasks(outDir, downloaded.imagesDir, assignments);
  }

  console.log(
    `\n完成（${
      options.design === 'same' ? '同图配对，三任务各标一遍' : '一次性拆分'
    }）。下一步：`,
  );
  console.log('1. 在 LR-Agent 中分别创建三个任务（类型：图片 / 矩形框）：');
  for (const condition of ['A', 'B', 'C']) {
    console.log(
      `   ${condition} → ${path.join(outDir, 'tasks', condition)}` +
        `（${assignments[condition].length} 张）`,
    );
  }
  console.log('2. 每个任务加入同一套中文标签：');
  console.log(`   ${LABEL_POOL.map((l) => l.projectName).join('、')}`);
  console.log('3. 按 README 运行 A / B / C 三个 run（标签 A、B、C）。');
}

/** 直接运行时执行主流程；被测试 import 时只暴露辅助函数。 */
const isDirectRun =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/**
 * 实验快照：把某个任务目录的标注状态复制到实验运行目录，用于「AI 阶段 vs 修正后」对比。
 *
 * 标注真源在 `<task>/.lr-agent/annotations/`（index.json + files/*.json），
 * 以及 `<task>/.lr-agent/project.json`（标签 id ↔ 名称）。本脚本只做复制，
 * 不触碰任务目录本身，可随时重复执行（覆盖同名快照）。
 *
 * 用法：
 *   node scripts/experiments/snapshotAnnotations.mjs \
 *     --task experiments/data/tasks/C --run C-s1 --stage ai
 *   node scripts/experiments/snapshotAnnotations.mjs \
 *     --task experiments/data/tasks/C --run C-s1 --stage final \
 *     --meta model=deepseek-chat --meta yolo=yolov8s.pt
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = {
    task: null,
    run: null,
    stage: null,
    out: path.join(root, 'experiments', 'runs'),
    meta: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--task') options.task = path.resolve(argv[++i]);
    else if (arg === '--run') options.run = argv[++i];
    else if (arg === '--stage') options.stage = argv[++i];
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else if (arg === '--meta') {
      const pair = String(argv[++i] ?? '');
      const eq = pair.indexOf('=');
      if (eq > 0) options.meta[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  if (!options.task || !options.run || !options.stage) {
    console.error('用法: --task <任务目录> --run <run 标签> --stage <ai|final> [--meta k=v ...]');
    process.exit(2);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hiddenDir = path.join(options.task, '.lr-agent');
  const annotationsDir = path.join(hiddenDir, 'annotations');
  const projectFile = path.join(hiddenDir, 'project.json');

  if (!(await exists(annotationsDir))) {
    throw new Error(`未找到标注目录：${annotationsDir}（请先在应用中打开并保存该任务）`);
  }

  const runDir = path.join(options.out, options.run);
  const stageDir = path.join(runDir, options.stage);
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  await fs.cp(annotationsDir, path.join(stageDir, 'annotations'), {
    recursive: true,
  });
  if (await exists(projectFile)) {
    await fs.copyFile(projectFile, path.join(stageDir, 'project.json'));
  }

  const indexFile = path.join(annotationsDir, 'index.json');
  let annotationFileCount = 0;
  if (await exists(indexFile)) {
    const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    annotationFileCount = Object.keys(index.files ?? {}).length;
  }

  const metaFile = path.join(runDir, 'meta.json');
  let meta = {};
  if (await exists(metaFile)) {
    meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  }
  meta.run = options.run;
  meta.task = options.task;
  meta.stages = {
    ...(meta.stages ?? {}),
    [options.stage]: {
      at: new Date().toISOString(),
      fileCount: annotationFileCount,
    },
  };
  meta.frozen = { ...(meta.frozen ?? {}), ...options.meta };
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));

  console.log(
    `快照完成：${stageDir}（${annotationFileCount} 个标注文件）`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

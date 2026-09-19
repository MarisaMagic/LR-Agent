/**
 * CI 轻量检查：推理侧（vendor/inference）依赖清单与安装器常量的一致性。
 *
 * 背景：Agent 编排已迁到 Node 运行时，原 `python-envs` job（装 torch +
 * ultralytics + sam2 做 import 冒烟，90 分钟超时）失去了前提——它依赖的嵌入式
 * Python 运行时已移除，产品语义也变成「用户自备 conda 环境」。但推理服务仍是
 * 发布产物的一部分，此前只靠 `envInstaller.ts` 与 `ciInstallAndTest.mjs` 的
 * 注释互相声称"保持字面同步"，没有任何 CI 把关。
 *
 * 本脚本把那句注释变成可验证的断言，成本近乎为零（无需装任何 Python 依赖）：
 *   1. 安装器里的 SAM-2 改写链在真实清单上确实能命中
 *   2. torch 索引 URL 与清单中的 torch 系列本地版本标签一致
 *   3. cpu / gpu 两份清单除 torch 系列与索引外完全一致（防单边漂移）
 *   4. VERIFY_IMPORTS 里每个 import 名都能在清单里找到对应发行包
 *   5. Python 编排退场的残留引用不得回归
 *   6. 推理服务仍被计入打包产物，且必需模块文件齐全
 *
 * 用法: node scripts/ciCheckInferenceManifests.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INSTALLER = path.join(root, 'src', 'main', 'env', 'envInstaller.ts');
const ENV_TYPES = path.join(root, 'src', 'shared', 'envTypes.ts');
const RUNTIME_MANAGER = path.join(root, 'src', 'main', 'env', 'runtimeManager.ts');
const PKG = path.join(root, 'package.json');
const INFERENCE_DIR = path.join(root, 'vendor', 'inference');

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 从 TS 源码里取 `const NAME = '...'` 的字符串字面量（支持跨行拼接）。 */
function stringConst(source, name) {
  const re = new RegExp(
    `const\\s+${name}\\s*=\\s*((?:'(?:[^'\\\\]|\\\\.)*'\\s*\\+?\\s*)+)`,
  );
  const m = source.match(re);
  if (!m) return null;
  const parts = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((p) => p[1]);
  return parts.length > 0 ? parts.join('') : null;
}

// ── 解析 requirements 清单 ──────────────────────────────────────────

/**
 * 解析 requirements.txt。
 *
 * 返回 `options`（`--xxx` 开头的 pip 参数）与 `packages`（发行包名 → 版本说明）。
 * 兼容两处历史写法：`name==version` 与 PEP 508 直链 `Name @ url`。
 */
function parseRequirements(content) {
  const options = [];
  const packages = new Map();
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('-')) {
      options.push(line);
      continue;
    }
    const at = line.indexOf(' @ ');
    if (at > 0) {
      packages.set(line.slice(0, at).trim(), `@ ${line.slice(at + 3).trim()}`);
      continue;
    }
    const eq = line.indexOf('==');
    if (eq > 0) {
      packages.set(line.slice(0, eq).trim(), line.slice(eq + 2).trim());
      continue;
    }
    packages.set(line, '*');
  }
  return { options, packages };
}

/** 索引 URL 的本地版本标签：`.../whl/cu121` → `cu121`。 */
function indexTag(url) {
  const seg = url.replace(/\/+$/, '').split('/').pop();
  return seg || '';
}

/** `--extra-index-url <url>` 中声明的索引。 */
function declaredIndex(options) {
  const entry = options.find((o) => o.startsWith('--extra-index-url'));
  if (!entry) return null;
  return entry.split(/\s+/)[1] ?? null;
}

// ── 读取输入 ────────────────────────────────────────────────────────

const installerSource = fs.readFileSync(INSTALLER, 'utf8');
const envTypesSource = fs.readFileSync(ENV_TYPES, 'utf8');
const runtimeManagerSource = fs.readFileSync(RUNTIME_MANAGER, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

const SAM2_GIT_URL = stringConst(installerSource, 'SAM2_GIT_URL');
const SAM2_ARCHIVE_URL = stringConst(installerSource, 'SAM2_ARCHIVE_URL');
const TORCH_GPU_INDEX = stringConst(installerSource, 'TORCH_GPU_INDEX');
const TORCH_CPU_INDEX = stringConst(installerSource, 'TORCH_CPU_INDEX');
const verifyImportsMatch = installerSource.match(
  /const\s+VERIFY_IMPORTS[^=]*=\s*\{([\s\S]*?)\};/,
);
const verifyImports = verifyImportsMatch
  ? (verifyImportsMatch[1].match(/inference\s*:\s*'([^']*)'/)?.[1] ?? null)
  : null;

const manifests = {
  cpu: parseRequirements(
    fs.readFileSync(path.join(INFERENCE_DIR, 'requirements-cpu.txt'), 'utf8'),
  ),
  gpu: parseRequirements(
    fs.readFileSync(path.join(INFERENCE_DIR, 'requirements-gpu.txt'), 'utf8'),
  ),
};

console.log('[ciCheckInferenceManifests] 推理依赖清单一致性');

// ── 1. 安装器常量存在，且与清单对得上 ──────────────────────────────

console.log('\n1) 安装器常量');
check(!!SAM2_GIT_URL, 'envInstaller.ts 定义 SAM2_GIT_URL');
check(!!SAM2_ARCHIVE_URL, 'envInstaller.ts 定义 SAM2_ARCHIVE_URL');
check(!!TORCH_CPU_INDEX, 'envInstaller.ts 定义 TORCH_CPU_INDEX');
check(!!TORCH_GPU_INDEX, 'envInstaller.ts 定义 TORCH_GPU_INDEX');

// ── 2. SAM-2 改写链在真实清单上确实命中 ────────────────────────────

console.log('\n2) SAM-2 git+https → 归档 zip 改写链');
if (SAM2_GIT_URL && SAM2_ARCHIVE_URL) {
  for (const variant of ['cpu', 'gpu']) {
    const sam2 = [...manifests[variant].packages].find(([name]) =>
      /^sam-?2$/i.test(name),
    );
    // sanitizeRequirements 用 `line.includes(SAM2_GIT_URL)` 判断，二者必须真能匹配
    check(
      Boolean(sam2) && sam2[1].includes(SAM2_GIT_URL),
      `${variant} 清单的 SAM-2 行含 SAM2_GIT_URL（改写分支能命中）`,
      sam2 ? sam2[1] : '未找到 SAM-2 依赖',
    );
    // 归档 URL 不该已经写在清单里，否则改写是空操作、语义漂移
    check(
      Boolean(sam2) && !sam2[1].includes(SAM2_ARCHIVE_URL.split(' ').pop()),
      `${variant} 清单未预先写入归档 URL（改写非空操作）`,
    );
  }
}

// ── 3. torch 索引与本地版本标签一致 ────────────────────────────────

console.log('\n3) torch 索引 URL ↔ 本地版本标签');
for (const [variant, index] of [
  ['cpu', TORCH_CPU_INDEX],
  ['gpu', TORCH_GPU_INDEX],
]) {
  const { options, packages } = manifests[variant];
  const tag = index ? indexTag(index) : '';

  check(
    Boolean(index) && declaredIndex(options) === index,
    `${variant} 清单声明的 extra-index-url 等于 TORCH_${variant.toUpperCase()}_INDEX`,
    `期望 ${index}，实际 ${declaredIndex(options)}`,
  );

  for (const name of ['torch', 'torchvision']) {
    const version = packages.get(name);
    check(
      typeof version === 'string' && version.endsWith(`+${tag}`),
      `${variant} 清单 ${name} 的本地版本标签为 +${tag}`,
      `实际 ${version}`,
    );
  }
}

// ── 4. 两份清单除 torch 系列外必须一致 ─────────────────────────────

console.log('\n4) cpu / gpu 清单差异范围');
const TORCH_FAMILY = new Set(['torch', 'torchvision']);
const namesOf = (variant) =>
  [...manifests[variant].packages.keys()].sort().join('\n');
check(
  namesOf('cpu') === namesOf('gpu'),
  'cpu / gpu 的发行包集合完全相同（差异只允许在版本标签）',
);
const versionDrift = [...manifests.cpu.packages].filter(([name, version]) => {
  if (TORCH_FAMILY.has(name)) return false;
  return manifests.gpu.packages.get(name) !== version;
});
check(
  versionDrift.length === 0,
  '非 torch 系列的版本钉法在两份清单中一致',
  versionDrift.map(([n]) => n).join(', '),
);

// ── 5. VERIFY_IMPORTS 的 import 名都能落到清单里的发行包 ───────────

console.log('\n5) VERIFY_IMPORTS 覆盖');
// import 名与 pip 发行包名并不总是同名，这里维护已知映射
const IMPORT_TO_DIST = {
  torch: 'torch',
  torchvision: 'torchvision',
  ultralytics: 'ultralytics',
  cv2: 'opencv-python',
  PIL: 'pillow',
  sam2: 'SAM-2',
};
if (verifyImports) {
  for (const mod of verifyImports.split(',').map((s) => s.trim())) {
    const dist = IMPORT_TO_DIST[mod];
    check(
      Boolean(dist),
      `import ${mod} 有对应的发行包映射（新增依赖时请同步 IMPORT_TO_DIST）`,
    );
    if (!dist) continue;
    const hit = [...manifests.cpu.packages.keys()].some(
      (name) => name.toLowerCase() === dist.toLowerCase(),
    );
    check(hit, `${mod} → ${dist} 存在于清单中`);
  }
} else {
  check(false, 'envInstaller.ts 中可解析出 VERIFY_IMPORTS.inference');
}

// ── 6. Python 编排退场的残留引用不得回归 ───────────────────────────

console.log('\n6) 已移除能力的残留引用');
check(
  !/local-agent/.test(installerSource),
  'envInstaller.ts 不再提及 local-agent',
);
check(
  !/python-runtime/.test(installerSource),
  'envInstaller.ts 不再提及 python-runtime',
);
// 只断言类型声明本身：文件里保留「原先还有 'local-agent'」这类历史说明是
// 刻意为之（解释为何收敛），不该被当成残留引用。
const installTargetDecl =
  envTypesSource.match(/export\s+type\s+InstallTarget\s*=\s*([^;]+);/)?.[1] ?? '';
check(
  Boolean(installTargetDecl) && !/'local-agent'/.test(installTargetDecl),
  "shared/envTypes.ts 的 InstallTarget 声明不再含 'local-agent'",
  `实际 ${installTargetDecl.trim()}`,
);
check(
  !/'local-agent'/.test(runtimeManagerSource),
  'runtimeManager.ts 的 TARGET_PYTHON_VERSION 不再含 local-agent',
);
check(
  !pkg.scripts['fetch-python-runtimes'],
  'package.json 不再有 fetch-python-runtimes 脚本',
);
check(
  !fs.existsSync(path.join(root, 'scripts', 'fetchPythonRuntimes.mjs')),
  'scripts/fetchPythonRuntimes.mjs 已删除',
);

// ── 7. 推理服务仍属打包产物，且模块文件齐全 ────────────────────────

console.log('\n7) 推理服务打包完整性');
const extraResources = JSON.stringify(pkg.build?.extraResources ?? []);
check(
  extraResources.includes('vendor/inference'),
  'package.json 的 extraResources 仍包含 vendor/inference',
);
for (const rel of [
  'server.py',
  'runners/__init__.py',
  'runners/dispatch.py',
  'runners/keypoint.py',
  'runners/runtime.py',
  'runners/sam2_runner.py',
  'runners/yolo.py',
]) {
  check(fs.existsSync(path.join(INFERENCE_DIR, rel)), `vendor/inference/${rel} 存在`);
}

console.log(
  failures
    ? `\n[ciCheckInferenceManifests] 失败 ${failures} 项`
    : '\n[ciCheckInferenceManifests] 全部通过',
);
process.exitCode = failures ? 1 : 0;

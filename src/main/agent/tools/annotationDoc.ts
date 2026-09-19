/**
 * `read_file_annotation`：读取项目内某文件的已有标注。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/registry.py` 的 `read_file_annotation`
 * 与 `app/agent/annotation/annotation_doc_reader.py`。
 *
 * 标注文档路径规则：`<project_dir>/.lr-agent/annotations/files/<sha256(相对路径)>.json`。
 * 哈希逻辑与 Electron 侧完全一致——这里**直接 import** 主进程的
 * `annotationDataStore`（它只依赖 path/crypto/fs-extra，不依赖 Electron），
 * 因此不存在重复实现导致 fileKey 漂移的风险。
 *
 * 分页：默认返回前 200 条，上限 500；整体超过 40000 字符时截断并提示分页。
 */

import { readAnnotationDocRaw } from '../../annotation/annotationDataStore';
import {
  normalizeRelativePath,
  projectDirectory,
  type ClientContextLike,
} from './workspacePath';

/** 结果总体字符上限（对齐 Python 的 40_000）。 */
const MAX_RESULT_CHARS = 40_000;

/** 单次返回条数上限（对齐 Python 的 500）。 */
const MAX_LIMIT = 500;

export async function readFileAnnotationTool(
  clientContext: ClientContextLike | null,
  relativePath: string,
  options: { offset?: number; limit?: number } = {},
): Promise<string> {
  const projectDir = projectDirectory(clientContext);
  if (!projectDir) {
    return '无法读取标注：未绑定项目目录。请确认已在标注任务中打开项目。';
  }

  const rel = normalizeRelativePath((relativePath ?? '').trim());
  if (!rel) {
    // 与 Python 的 annotation_doc_reader 一致地提示（registry 层先做了 project 检查）
    return '请提供相对路径（如 data/2.jpg）。';
  }

  const raw = await readAnnotationDocRaw(projectDir, rel);
  if (raw === null) {
    return `未找到 ${rel} 的标注文件（可能尚未标注）。`;
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return `读取标注失败：${errMessage(err)}`;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return '标注文件格式无效。';
  }

  let record = doc as Record<string, unknown>;
  // 文档内的 `filePath` 是冗余字段（权威归属由存储键决定，即入参 rel）。
  // 历史数据可能因旧的防抖错配残留错误值；这里强制对齐，避免把脏数据
  // 当作「工具返回字段错位」反馈给模型与用户。
  if (record.filePath !== rel) {
    record = { ...record, filePath: rel };
  }

  let note = '';

  const { annotations } = record;
  if (Array.isArray(annotations)) {
    const total = annotations.length;
    const start = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(
      1,
      Math.min(Math.floor(options.limit ?? 200), MAX_LIMIT),
    );
    const end = Math.min(start + limit, total);
    if (start > 0 || end < total) {
      record.annotations = annotations.slice(start, end);
      note =
        `（共 ${total} 条标注，当前返回第 ${start + 1}-${end} 条；` +
        '可用 annotation_offset/annotation_limit 分页读取其余）\n';
    }
  }

  // 带缩进：Python 的 indent=2 与 JSON.stringify(v, null, 2) 的分隔符行为一致
  let text = JSON.stringify(record, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(
      0,
      MAX_RESULT_CHARS,
    )}\n…[结果已截断，请用 annotation_offset/annotation_limit 分页读取]`;
  }
  return note + text;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

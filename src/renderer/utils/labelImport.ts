import { LABEL_COLOR_PRESETS, LabelDefinition } from '../types/annotation';

export interface ImportedLabel {
  name: string;
  color?: string;
}

export interface LabelImportParseResult {
  items: ImportedLabel[];
  invalidMessages: string[];
  fatalError: string | null;
}

export interface LabelMergeResult {
  next: LabelDefinition[];
  added: LabelDefinition[];
  duplicateNames: string[];
}

export interface LabelImportPlan {
  fatalError: string | null;
  imported: LabelDefinition[];
  duplicateNames: string[];
  invalidMessages: string[];
}

/** Marker appended by the main-process `fs:readFile` handler for oversized files. */
const TRUNCATION_MARKER = '[文件过大，仅显示部分内容]';

const NAME_KEYS = ['name', 'label', 'className', 'class'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTruncatedReadFileResult(text: string): boolean {
  return typeof text === 'string' && text.includes(TRUNCATION_MARKER);
}

function createLabelId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `label-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : undefined;
}

function presetColor(index: number): string {
  return LABEL_COLOR_PRESETS[index % LABEL_COLOR_PRESETS.length];
}

function extractArray(
  root: unknown,
): { items: unknown[] } | { fatalError: string } {
  if (Array.isArray(root)) {
    return { items: root };
  }
  if (isRecord(root)) {
    for (const key of ['labels', 'categories', 'classes']) {
      if (Array.isArray(root[key])) {
        return { items: root[key] as unknown[] };
      }
    }
  }
  return {
    fatalError:
      'JSON 结构无法识别：需要标签数组，或含 labels/categories/classes 字段的对象。',
  };
}

function extractName(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (isRecord(item)) {
    for (const key of NAME_KEYS) {
      const value = item[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

function extractColor(item: unknown): string | undefined {
  if (isRecord(item)) {
    return normalizeHexColor(item.color);
  }
  return undefined;
}

/**
 * Tolerant parser for a labels JSON file.
 * Accepts a bare array, or an object wrapping `labels` / `categories` / `classes`.
 * Array items may be strings or objects exposing a name via `name`/`label`/`className`/`class`,
 * with an optional `#RRGGBB` `color`. IDs are intentionally ignored so the importer can mint them.
 */
export function parseLabelsJson(text: string): LabelImportParseResult {
  const invalidMessages: string[] = [];
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : '';

  if (!source.trim()) {
    return { items: [], invalidMessages, fatalError: '文件内容为空。' };
  }

  let root: unknown;
  try {
    root = JSON.parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      items: [],
      invalidMessages,
      fatalError: `JSON 解析失败：${detail}`,
    };
  }

  const extracted = extractArray(root);
  if ('fatalError' in extracted) {
    return { items: [], invalidMessages, fatalError: extracted.fatalError };
  }

  const items: ImportedLabel[] = [];
  extracted.items.forEach((raw, index) => {
    const name = extractName(raw);
    if (!name) {
      invalidMessages.push(`第 ${index + 1} 项缺少有效的 name，已跳过。`);
      return;
    }
    items.push({ name, color: extractColor(raw) });
  });

  if (items.length === 0 && invalidMessages.length === 0) {
    return { items: [], invalidMessages, fatalError: null };
  }

  return { items, invalidMessages, fatalError: null };
}

/**
 * Appends imported labels to the existing list, skipping names that already exist
 * (case-insensitive) or repeat within the import. Order is preserved for export indices.
 */
export function mergeLabels(
  existing: LabelDefinition[],
  imported: ImportedLabel[],
): LabelMergeResult {
  const seen = new Set<string>();
  existing.forEach((label) => {
    const key = label.name.trim().toLowerCase();
    if (key) seen.add(key);
  });

  const added: LabelDefinition[] = [];
  const duplicateNames: string[] = [];

  imported.forEach((item) => {
    const name = item.name.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      duplicateNames.push(name);
      return;
    }
    seen.add(key);
    added.push({
      id: createLabelId(),
      name,
      color: item.color ?? presetColor(existing.length + added.length),
    });
  });

  return { next: [...existing, ...added], added, duplicateNames };
}

export function planLabelImport(
  text: string,
  existing: LabelDefinition[],
): LabelImportPlan {
  const parsed = parseLabelsJson(text);
  if (parsed.fatalError) {
    return {
      fatalError: parsed.fatalError,
      imported: [],
      duplicateNames: [],
      invalidMessages: parsed.invalidMessages,
    };
  }

  const merged = mergeLabels(existing, parsed.items);
  return {
    fatalError: null,
    imported: merged.added,
    duplicateNames: merged.duplicateNames,
    invalidMessages: parsed.invalidMessages,
  };
}

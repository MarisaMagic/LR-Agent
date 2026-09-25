import { describe, expect, it } from '@jest/globals';
import { LABEL_COLOR_PRESETS, LabelDefinition } from '../types/annotation';
import {
  isTruncatedReadFileResult,
  mergeLabels,
  parseLabelsJson,
  planLabelImport,
} from './labelImport';

function existing(...names: string[]): LabelDefinition[] {
  return names.map((name, index) => ({
    id: `existing-${index}`,
    name,
    color: LABEL_COLOR_PRESETS[0],
  }));
}

describe('parseLabelsJson', () => {
  it('接受裸字符串数组', () => {
    const result = parseLabelsJson('["cat", "dog"]');
    expect(result.fatalError).toBeNull();
    expect(result.items).toEqual([
      { name: 'cat', color: undefined },
      { name: 'dog', color: undefined },
    ]);
    expect(result.invalidMessages).toEqual([]);
  });

  it('接受对象数组并保留合法颜色', () => {
    const result = parseLabelsJson('[{"name":"cat","color":"#00ff00"}]');
    expect(result.items).toEqual([{ name: 'cat', color: '#00ff00' }]);
  });

  it('非法颜色被忽略', () => {
    const result = parseLabelsJson('[{"name":"cat","color":"red"}]');
    expect(result.items[0].color).toBeUndefined();
  });

  it('支持 {labels:[...]} 包裹', () => {
    const result = parseLabelsJson('{"labels":["a","b"]}');
    expect(result.items.map((i) => i.name)).toEqual(['a', 'b']);
  });

  it('支持 {categories:[...]}（COCO 风格，忽略 id/supercategory）', () => {
    const result = parseLabelsJson(
      '{"categories":[{"id":1,"name":"apple","supercategory":"fruit"}]}',
    );
    expect(result.items).toEqual([{ name: 'apple', color: undefined }]);
  });

  it('支持 {classes:[...]}', () => {
    const result = parseLabelsJson('{"classes":["x"]}');
    expect(result.items.map((i) => i.name)).toEqual(['x']);
  });

  it('兼容 label / className 字段名', () => {
    const result = parseLabelsJson('[{"label":"a"},{"className":"b"}]');
    expect(result.items.map((i) => i.name)).toEqual(['a', 'b']);
  });

  it('剥离 UTF-8 BOM', () => {
    const result = parseLabelsJson('\uFEFF["a"]');
    expect(result.fatalError).toBeNull();
    expect(result.items.map((i) => i.name)).toEqual(['a']);
  });

  it('非法 JSON 返回 fatalError', () => {
    const result = parseLabelsJson('{not json');
    expect(result.fatalError).toContain('JSON 解析失败');
    expect(result.items).toEqual([]);
  });

  it('无法识别的结构返回 fatalError', () => {
    expect(parseLabelsJson('{"foo":1}').fatalError).toBeTruthy();
    expect(parseLabelsJson('123').fatalError).toBeTruthy();
  });

  it('空内容返回 fatalError', () => {
    expect(parseLabelsJson('   ').fatalError).toBeTruthy();
  });

  it('缺少 name 的项记入 invalidMessages', () => {
    const result = parseLabelsJson('[{"name":"a"},{"color":"#ffffff"},42]');
    expect(result.items.map((i) => i.name)).toEqual(['a']);
    expect(result.invalidMessages).toHaveLength(2);
  });
});

describe('mergeLabels', () => {
  it('对现有标签按名去重（忽略大小写）', () => {
    const result = mergeLabels(existing('cat'), [
      { name: 'CAT' },
      { name: 'dog' },
    ]);
    expect(result.added.map((l) => l.name)).toEqual(['dog']);
    expect(result.duplicateNames).toEqual(['CAT']);
  });

  it('对导入内部重复去重', () => {
    const result = mergeLabels([], [{ name: 'cat' }, { name: 'cat' }]);
    expect(result.added).toHaveLength(1);
    expect(result.duplicateNames).toEqual(['cat']);
  });

  it('保持追加顺序并生成新 id', () => {
    const base = existing('a');
    const result = mergeLabels(base, [{ name: 'b' }, { name: 'c' }]);
    expect(result.next.map((l) => l.name)).toEqual(['a', 'b', 'c']);
    expect(result.added[0].id).not.toBe(base[0].id);
  });

  it('缺省颜色按预设续接现有数量', () => {
    const result = mergeLabels(existing('a'), [{ name: 'b' }]);
    expect(result.added[0].color).toBe(LABEL_COLOR_PRESETS[1]);
  });

  it('保留导入时提供的合法颜色', () => {
    const result = mergeLabels([], [{ name: 'b', color: '#123456' }]);
    expect(result.added[0].color).toBe('#123456');
  });
});

describe('planLabelImport', () => {
  it('组合解析与合并', () => {
    const plan = planLabelImport('["a","b"]', existing('a'));
    expect(plan.fatalError).toBeNull();
    expect(plan.imported.map((l) => l.name)).toEqual(['b']);
    expect(plan.duplicateNames).toEqual(['a']);
  });

  it('致命错误时不产出任何标签', () => {
    const plan = planLabelImport('nope', existing('a'));
    expect(plan.fatalError).toBeTruthy();
    expect(plan.imported).toEqual([]);
  });
});

describe('isTruncatedReadFileResult', () => {
  it('识别主进程的截断标记', () => {
    expect(
      isTruncatedReadFileResult('xxx\n\n... [文件过大，仅显示部分内容]'),
    ).toBe(true);
    expect(isTruncatedReadFileResult('["a"]')).toBe(false);
  });
});

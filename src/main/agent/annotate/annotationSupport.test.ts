/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { pyIntListRepr, pyRepr } from './common';
import {
  AnnotationScope,
  coerceStrList,
  expandDetectionAliases,
  filterLabelCandidatesByScope,
  inferAnnotationScopeFromText,
  mergeAnnotationScope,
  normalizeDetectionLabel,
  SCOPE_KEYWORD_TO_DETECTION,
} from './scope';
import {
  labelsRequireVisionMapping,
  normLabel,
  YOLO_COCO_CLASS_NAMES,
} from './visionPolicy';
import { heuristicMapBoxes, NO_MATCH_REASON } from './heuristic';
import {
  candidatesForRetryBox,
  findLabelNamesInText,
  formatIssuesForRetry,
  MappingIssueCode,
  validateVisionMappings,
} from './validation';
import { shouldRunPreflight } from './labelPool';
import { coordsAreNormalized, toPixelRect } from './mapLabels';

describe('pyRepr：Python 字符串 repr 等价', () => {
  it('普通字符串用单引号', () => {
    expect(pyRepr('car')).toBe("'car'");
  });

  it('含单引号而无双引号时改用双引号', () => {
    expect(pyRepr("it's")).toBe('"it\'s"');
  });

  it('两种引号都有时用单引号并转义', () => {
    expect(pyRepr(`a'b"c`)).toBe("'a\\'b\"c'");
  });

  it('转义换行与制表符', () => {
    expect(pyRepr('a\nb\tc')).toBe("'a\\nb\\tc'");
  });

  it('null 输出 None', () => {
    expect(pyRepr(null)).toBe('None');
  });

  it('中文原样保留', () => {
    expect(pyRepr('人脸')).toBe("'人脸'");
  });
});

describe('pyIntListRepr', () => {
  it('元素间带空格（Python repr 风格）', () => {
    expect(pyIntListRepr([0, 1])).toBe('[0, 1]');
    expect(pyIntListRepr([3])).toBe('[3]');
  });
});

describe('coerceStrList：Pydantic 校验器等价', () => {
  it('null 返回空数组', () => {
    expect(coerceStrList(null)).toEqual([]);
    expect(coerceStrList(undefined)).toEqual([]);
  });

  it('非空字符串包成单元素数组', () => {
    expect(coerceStrList(' a ')).toEqual(['a']);
  });

  it('空字符串返回空数组', () => {
    expect(coerceStrList('   ')).toEqual([]);
  });

  it('数组逐项 str+trim 并丢弃空项', () => {
    expect(coerceStrList([' a ', '', '   ', 'b'])).toEqual(['a', 'b']);
  });

  it('数字项被转成字符串', () => {
    expect(coerceStrList([1, 2])).toEqual(['1', '2']);
  });

  it('其它类型返回空数组', () => {
    expect(coerceStrList(42)).toEqual([]);
    expect(coerceStrList({ a: 1 })).toEqual([]);
  });
});

describe('normalizeDetectionLabel', () => {
  it('strip + lower + 下划线换空格 + 折叠空白', () => {
    expect(normalizeDetectionLabel('  Sports_Ball  ')).toBe('sports ball');
    expect(normalizeDetectionLabel('a   b')).toBe('a b');
  });
});

describe('expandDetectionAliases', () => {
  it('中文关键词展开为英文别名', () => {
    expect(expandDetectionAliases(['篮球'])).toEqual([
      'sports ball',
      'basketball',
    ]);
  });

  it('未命中的词原样作为别名输出', () => {
    expect(expandDetectionAliases(['unknown_term'])).toEqual(['unknown_term']);
  });

  it('按归一化值去重但输出原值', () => {
    expect(expandDetectionAliases(['人', '人物', '人体'])).toEqual(['person']);
  });

  it('空词被跳过', () => {
    expect(expandDetectionAliases(['', '  '])).toEqual([]);
  });
});

describe('inferAnnotationScopeFromText：范围推断', () => {
  it('「只标注人脸」推断出 person/face', () => {
    const scope = inferAnnotationScopeFromText('只标注人脸');
    expect(scope.include_detection_labels).toEqual(['person', 'face']);
    expect(scope.scope_summary).toBe('仅标注人脸');
  });

  it('「不要标注篮球」推断出排除项', () => {
    const scope = inferAnnotationScopeFromText('不要标注篮球');
    expect(scope.exclude_detection_labels).toEqual([
      'sports ball',
      'basketball',
    ]);
  });

  it('取分隔符前的第一段作为范围词', () => {
    const scope = inferAnnotationScopeFromText('只标注人脸，其他都不要');
    expect(scope.include_detection_labels).toEqual(['person', 'face']);
  });

  it('无「只/仅」但有「人脸」时触发兜底', () => {
    const scope = inferAnnotationScopeFromText('图里有人脸');
    expect(scope.include_detection_labels).toEqual(['person', 'face']);
    expect(scope.scope_summary).toBe('仅标注人脸/人物');
  });

  it('「人物」+「标注」触发另一条兜底', () => {
    const scope = inferAnnotationScopeFromText('标注一下人物');
    expect(scope.include_detection_labels).toEqual(['person']);
    expect(scope.scope_summary).toBe('仅标注人物');
  });

  it('篮球 + 否定词触发特殊排除', () => {
    const scope = inferAnnotationScopeFromText('篮球不要');
    expect(scope.exclude_detection_labels).toContain('sports ball');
  });

  it('同一行内两次「只标注」会被贪婪正则合并为单个范围词', () => {
    // `(.{1,24})` 是贪婪的且 `.` 匹配「只/标/注」，因此同一行不会有第二个匹配
    const scope = inferAnnotationScopeFromText('只标注人脸只标注汽车');
    expect(scope.include_detection_labels).toEqual(['人脸只标注汽车']);
    expect(scope.scope_summary).toBe('');
  });

  it('换行分隔时产生多个范围词，最后一个决定 summary', () => {
    const scope = inferAnnotationScopeFromText('只标注人脸\n只标注汽车');
    expect(scope.scope_summary).toBe('仅标注汽车');
    expect(scope.include_detection_labels).toContain('person');
    expect(scope.include_detection_labels).toContain('car');
  });

  it('exclude 侧第一个命中决定 summary', () => {
    const scope = inferAnnotationScopeFromText('不要猫\n不要狗');
    expect(scope.scope_summary).toBe('排除猫');
    expect(scope.exclude_detection_labels).toEqual(['cat', 'dog']);
  });

  it('include 已设 summary 时 exclude 不覆盖', () => {
    const scope = inferAnnotationScopeFromText('只标注人脸\n不要狗');
    expect(scope.scope_summary).toBe('仅标注人脸');
    expect(scope.exclude_detection_labels).toEqual(['dog']);
  });

  it('label_names 在「只/仅」语境下收进 include_label_names', () => {
    const scope = inferAnnotationScopeFromText('只要 Curry', {
      labelNames: ['Curry', 'James'],
    });
    expect(scope.include_label_names).toEqual(['Curry']);
  });

  it('无「只/仅」时不收 label_names', () => {
    const scope = inferAnnotationScopeFromText('Curry 在哪', {
      labelNames: ['Curry'],
    });
    expect(scope.include_label_names).toEqual([]);
  });

  it('exclude_label_names 推断恒为空', () => {
    expect(
      inferAnnotationScopeFromText('不要 dog').exclude_label_names,
    ).toEqual([]);
  });

  it('空文本返回全默认', () => {
    const scope = inferAnnotationScopeFromText('   ');
    expect(scope.isRestricted()).toBe(false);
  });

  it('超出 24 字的范围词被正则截断为 24 字后采纳', () => {
    // 正则本身已限 1–24 字符，因此超长输入会被截断而非拒绝
    const scope = inferAnnotationScopeFromText(`只标注${'很'.repeat(30)}`);
    expect(scope.include_detection_labels).toEqual(['很'.repeat(24)]);
  });
});

describe('mergeAnnotationScope', () => {
  it('base 为空字段时被 inferred 覆盖', () => {
    const merged = mergeAnnotationScope(
      { scope_summary: '', include_detection_labels: [] },
      '只标注人脸',
    );
    expect(merged.scope_summary).toBe('仅标注人脸');
    expect(merged.include_detection_labels).toEqual(['person', 'face']);
  });

  it('base 已有值时不覆盖', () => {
    const merged = mergeAnnotationScope(
      { scope_summary: '已有摘要', include_detection_labels: ['car'] },
      '只标注人脸',
    );
    expect(merged.scope_summary).toBe('已有摘要');
    expect(merged.include_detection_labels).toEqual(['car']);
  });

  it('null 输入等价空 scope', () => {
    expect(
      mergeAnnotationScope(null, '只标注猫').include_detection_labels,
    ).toEqual(['cat']);
  });
});

describe('filterLabelCandidatesByScope', () => {
  const candidates = [
    { id: '1', name: 'Curry' },
    { id: '2', name: 'James' },
    { id: '3', name: 'jokic' },
  ];

  it('无 include/exclude 时返回同一对象', () => {
    const scope = new AnnotationScope();
    expect(filterLabelCandidatesByScope(candidates, scope)).toBe(candidates);
  });

  it('include 精确匹配（大小写不敏感）', () => {
    const scope = new AnnotationScope();
    scope.include_label_names = ['curry', 'JOKIC'];
    expect(
      filterLabelCandidatesByScope(candidates, scope).map((c) => c.id),
    ).toEqual(['1', '3']);
  });

  it('exclude 精确匹配', () => {
    const scope = new AnnotationScope();
    scope.exclude_label_names = ['james'];
    expect(
      filterLabelCandidatesByScope(candidates, scope).map((c) => c.id),
    ).toEqual(['1', '3']);
  });

  it('是精确匹配而非子串', () => {
    const scope = new AnnotationScope();
    scope.include_label_names = ['curr'];
    // 过滤后为空 → 回退返回原始全量（scope 失效）
    expect(filterLabelCandidatesByScope(candidates, scope)).toBe(candidates);
  });

  it('过滤后为空时回退返回全量', () => {
    const scope = new AnnotationScope();
    scope.include_label_names = ['nonexistent'];
    expect(filterLabelCandidatesByScope(candidates, scope)).toBe(candidates);
  });

  it('候选名不 strip（带空格的不会命中）', () => {
    const scope = new AnnotationScope();
    scope.include_label_names = ['curry'];
    const spaced = [{ id: '1', name: ' curry ' }];
    expect(filterLabelCandidatesByScope(spaced, scope)).toBe(spaced);
  });
});

describe('YOLO_COCO_CLASS_NAMES', () => {
  it('共 81 项（COCO 80 + face）', () => {
    expect(YOLO_COCO_CLASS_NAMES.size).toBe(81);
  });

  it('含关键项', () => {
    for (const name of [
      'person',
      'car',
      'sports ball',
      'dining table',
      'face',
    ]) {
      expect(YOLO_COCO_CLASS_NAMES.has(name)).toBe(true);
    }
  });

  it('不含球员姓名', () => {
    expect(YOLO_COCO_CLASS_NAMES.has('curry')).toBe(false);
  });
});

describe('labelsRequireVisionMapping', () => {
  it('全部未命中标准类名时返回 true', () => {
    expect(
      labelsRequireVisionMapping([{ name: 'Curry' }, { name: 'James' }]),
    ).toBe(true);
  });

  it('任一命中时返回 false', () => {
    expect(
      labelsRequireVisionMapping([{ name: 'Curry' }, { name: 'person' }]),
    ).toBe(false);
  });

  it('无有效标签名时返回 false', () => {
    expect(labelsRequireVisionMapping([])).toBe(false);
    expect(labelsRequireVisionMapping([{ name: '  ' }])).toBe(false);
  });

  it('下划线归一为空格后命中', () => {
    expect(labelsRequireVisionMapping([{ name: 'sports_ball' }])).toBe(false);
  });

  it('normLabel 不折叠内部连续空白（与 normalizeDetectionLabel 不同）', () => {
    expect(normLabel('a  b')).toBe('a  b');
    expect(normalizeDetectionLabel('a  b')).toBe('a b');
  });
});

describe('heuristicMapBoxes', () => {
  const candidates = [
    { id: 'l1', name: 'person' },
    { id: 'l2', name: 'car' },
  ];

  it('精确匹配（class_name）', () => {
    const result = heuristicMapBoxes([{ class_name: 'car' }], candidates);
    expect(result[0].label_id).toBe('l2');
    expect(result[0].reason).toBe("检测类名 'car' 与标签匹配");
  });

  it('class_name 为空时回退 detection_label', () => {
    const result = heuristicMapBoxes(
      [{ detection_label: 'person' }],
      candidates,
    );
    expect(result[0].label_id).toBe('l1');
  });

  it('精确匹配大小写不敏感', () => {
    expect(
      heuristicMapBoxes([{ class_name: 'CAR' }], candidates)[0].label_id,
    ).toBe('l2');
  });

  it('无匹配时 label_id 为空且 reason 为兜底文案', () => {
    const result = heuristicMapBoxes([{ class_name: 'airplane' }], candidates);
    expect(result[0].label_id).toBe('');
    expect(result[0].reason).toBe(NO_MATCH_REASON);
  });

  it('唯一部分匹配（双向子串）', () => {
    const result = heuristicMapBoxes(
      [{ class_name: 'sports' }],
      [
        { id: 'l1', name: 'sports ball' },
        { id: 'l2', name: 'car' },
      ],
    );
    expect(result[0].label_id).toBe('l1');
    expect(result[0].reason).toContain('部分匹配');
  });

  it('部分匹配多命中时不选', () => {
    const result = heuristicMapBoxes(
      [{ class_name: 'a' }],
      [
        { id: 'l1', name: 'abc' },
        { id: 'l2', name: 'abd' },
      ],
    );
    expect(result[0].label_id).toBe('');
  });

  it('OCR 唯一命中', () => {
    const result = heuristicMapBoxes(
      [{ class_name: 'unknown' }],
      [
        { id: 'l1', name: 'curry' },
        { id: 'l2', name: 'jokic' },
      ],
      '球员 curry 在场上',
    );
    expect(result[0].label_id).toBe('l1');
    expect(result[0].reason).toContain('OCR 含标签名');
  });

  it('OCR 多命中时不选', () => {
    const result = heuristicMapBoxes(
      [{ class_name: 'unknown' }],
      [
        { id: 'l1', name: 'curry' },
        { id: 'l2', name: 'jokic' },
      ],
      'curry 与 jokic',
    );
    expect(result[0].label_id).toBe('');
  });

  it('box_index 缺失时回退数组下标', () => {
    const result = heuristicMapBoxes(
      [{ class_name: 'car' }, { class_name: 'person' }],
      candidates,
    );
    expect(result.map((r) => r.box_index)).toEqual([0, 1]);
  });

  it('保留显式 box_index', () => {
    const result = heuristicMapBoxes(
      [{ box_index: 7, class_name: 'car' }],
      candidates,
    );
    expect(result[0].box_index).toBe(7);
  });
});

describe('validateVisionMappings', () => {
  const candidates = [
    { id: 'p1', name: 'Curry' },
    { id: 'p2', name: 'James' },
  ];

  it('全部合法时 ok', () => {
    const result = validateVisionMappings({
      mappings: [
        { box_index: 0, label_id: 'p1', reason: '图像中左侧球员' },
        { box_index: 1, label_id: 'p2', reason: '图像中右侧球员' },
      ],
      candidates,
      instanceLabels: true,
    });
    expect(result.ok).toBe(true);
  });

  it('无效 label_id 报错并跳过后续校验', () => {
    const result = validateVisionMappings({
      mappings: [{ box_index: 0, label_id: 'nope', reason: '无法确定' }],
      candidates,
      instanceLabels: true,
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe(MappingIssueCode.INVALID_LABEL_ID);
    expect(result.issues[0].message).toBe("label_id='nope' 不在候选中");
  });

  it('重复标签在实例标签场景报错（每个框各一条）', () => {
    const result = validateVisionMappings({
      mappings: [
        { box_index: 0, label_id: 'p1', reason: '' },
        { box_index: 1, label_id: 'p1', reason: '' },
      ],
      candidates,
      instanceLabels: true,
    });
    const dup = result.issues.filter(
      (i) => i.code === MappingIssueCode.DUPLICATE_LABEL,
    );
    expect(dup).toHaveLength(2);
    expect(dup[0].message).toContain("标签 'Curry' 被分配给多个框 [0, 1]");
  });

  it('非实例标签不检查重复', () => {
    const result = validateVisionMappings({
      mappings: [
        { box_index: 0, label_id: 'p1', reason: '' },
        { box_index: 1, label_id: 'p1', reason: '' },
      ],
      candidates,
      instanceLabels: false,
    });
    expect(result.ok).toBe(true);
  });

  it('reason 说无法确定却给了 label_id → 报错', () => {
    const result = validateVisionMappings({
      mappings: [{ box_index: 0, label_id: 'p1', reason: '无法确定这是谁' }],
      candidates,
      instanceLabels: true,
    });
    expect(
      result.issues.some(
        (i) => i.code === MappingIssueCode.REASON_CONTRADICTS_LABEL,
      ),
    ).toBe(true);
  });

  it('reason 说无法确定且 label_id 为空 → 合法', () => {
    const result = validateVisionMappings({
      mappings: [{ box_index: 0, label_id: '', reason: '无法确定' }],
      candidates,
      instanceLabels: true,
    });
    expect(result.ok).toBe(true);
  });

  it('reason 恰好指向另一个候选名 → 报 mismatch', () => {
    const result = validateVisionMappings({
      mappings: [{ box_index: 0, label_id: 'p2', reason: '这是 Curry' }],
      candidates,
      instanceLabels: true,
    });
    const mismatch = result.issues.find(
      (i) => i.code === MappingIssueCode.REASON_NAME_MISMATCH,
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toBe(
      "reason 指向 'Curry'，但 label_id 对应 'James'",
    );
  });

  it('reason 提到两个候选名时不报 mismatch', () => {
    const result = validateVisionMappings({
      mappings: [
        { box_index: 0, label_id: 'p2', reason: 'Curry 或 James 之一' },
      ],
      candidates,
      instanceLabels: true,
    });
    expect(
      result.issues.some(
        (i) => i.code === MappingIssueCode.REASON_NAME_MISMATCH,
      ),
    ).toBe(false);
  });

  it('reason 未提到候选名时不报 mismatch', () => {
    const result = validateVisionMappings({
      mappings: [{ box_index: 0, label_id: 'p2', reason: '右侧的球员' }],
      candidates,
      instanceLabels: true,
    });
    expect(result.ok).toBe(true);
  });

  it('issuesForBox 只返回该框问题', () => {
    const result = validateVisionMappings({
      mappings: [
        { box_index: 0, label_id: 'nope', reason: '' },
        { box_index: 1, label_id: 'p1', reason: '' },
      ],
      candidates,
      instanceLabels: true,
    });
    expect(result.issuesForBox(0)).toHaveLength(1);
    expect(result.issuesForBox(1)).toHaveLength(0);
  });
});

describe('formatIssuesForRetry', () => {
  it('空列表返回空串', () => {
    expect(formatIssuesForRetry([])).toBe('');
  });

  it('格式为 [code] message，用「；」连接', () => {
    expect(
      formatIssuesForRetry([
        {
          boxIndex: 0,
          code: MappingIssueCode.DUPLICATE_LABEL,
          message: 'msg1',
        },
        {
          boxIndex: 1,
          code: MappingIssueCode.INVALID_LABEL_ID,
          message: 'msg2',
        },
      ]),
    ).toBe('[duplicate_label] msg1；[invalid_label_id] msg2');
  });
});

describe('candidatesForRetryBox', () => {
  const candidates = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];

  it('空占用集合时原样返回', () => {
    expect(candidatesForRetryBox(candidates, new Set())).toBe(candidates);
  });

  it('排除已占用的 id', () => {
    const result = candidatesForRetryBox(candidates, new Set(['a']));
    expect(result.map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('保留当前框原有 label_id', () => {
    const result = candidatesForRetryBox(candidates, new Set(['a']), 'a');
    expect(result.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('全部被排除时回退全量', () => {
    const result = candidatesForRetryBox(candidates, new Set(['a', 'b', 'c']));
    expect(result).toBe(candidates);
  });
});

describe('findLabelNamesInText', () => {
  it('返回原始大小写并按候选顺序', () => {
    expect(
      findLabelNamesInText('jokic 与 Curry', [
        { name: 'Curry' },
        { name: 'Jokic' },
      ]),
    ).toEqual(['Curry', 'Jokic']);
  });

  it('按 lower 去重', () => {
    expect(
      findLabelNamesInText('curry', [{ name: 'Curry' }, { name: 'curry' }]),
    ).toEqual(['Curry']);
  });

  it('空文本返回空数组', () => {
    expect(findLabelNamesInText('', [{ name: 'Curry' }])).toEqual([]);
  });
});

describe('shouldRunPreflight', () => {
  it('off 恒不跑', () => {
    expect(
      shouldRunPreflight('off', {
        candidateCount: 100,
        boxCount: 1,
        minExtra: 0,
      }),
    ).toBe(false);
  });

  it('always 在框数 > 0 时恒跑', () => {
    expect(
      shouldRunPreflight('always', {
        candidateCount: 1,
        boxCount: 1,
        minExtra: 99,
      }),
    ).toBe(true);
  });

  it('框数为 0 时一律不跑', () => {
    expect(
      shouldRunPreflight('always', {
        candidateCount: 10,
        boxCount: 0,
        minExtra: 0,
      }),
    ).toBe(false);
  });

  it('auto 需候选数比框数多出至少 minExtra', () => {
    expect(
      shouldRunPreflight('auto', {
        candidateCount: 5,
        boxCount: 3,
        minExtra: 2,
      }),
    ).toBe(true);
    expect(
      shouldRunPreflight('auto', {
        candidateCount: 4,
        boxCount: 3,
        minExtra: 2,
      }),
    ).toBe(false);
  });
});

describe('coordsAreNormalized', () => {
  it('全部 <= 1.5 视为归一化', () => {
    expect(
      coordsAreNormalized([{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]),
    ).toBe(true);
  });

  it('任一 > 1.5 视为像素坐标', () => {
    expect(
      coordsAreNormalized([{ x: 100, y: 0.2, width: 0.3, height: 0.4 }]),
    ).toBe(false);
  });

  it('非法值视为像素坐标', () => {
    expect(coordsAreNormalized([{ x: 'abc' }])).toBe(false);
  });

  it('空数组返回 false', () => {
    expect(coordsAreNormalized([])).toBe(false);
  });
});

describe('toPixelRect', () => {
  const box = {
    box_index: 0,
    x: 0.25,
    y: 0.5,
    width: 0.5,
    height: 0.25,
    class_name: 'person',
    detection_label: 'person',
  };

  it('归一化框按图片尺寸换算', () => {
    expect(toPixelRect(box as never, 800, 400, true)).toEqual({
      left: 200,
      top: 200,
      right: 600,
      bottom: 300,
    });
  });

  it('像素框原样作为矩形', () => {
    expect(toPixelRect(box as never, 800, 400, false)).toEqual({
      left: 0.25,
      top: 0.5,
      right: 0.75,
      bottom: 0.75,
    });
  });
});

describe('SCOPE_KEYWORD_TO_DETECTION', () => {
  it('含 12 个关键词', () => {
    expect(Object.keys(SCOPE_KEYWORD_TO_DETECTION)).toHaveLength(12);
  });

  it('篮球映射到两个别名', () => {
    expect(SCOPE_KEYWORD_TO_DETECTION['篮球']).toEqual([
      'sports ball',
      'basketball',
    ]);
  });
});

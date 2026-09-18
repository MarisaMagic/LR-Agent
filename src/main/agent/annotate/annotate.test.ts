/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  AnnotateHttpError,
  coerceNullStringFields,
  extractJsonObject,
  httpFromLlmError,
  sanitizeJsonValue,
  sanitizeUnicodeText,
} from './common';
import {
  dumpMutationOperation,
  filterPaths,
  labelNamesOf,
} from './mutation';
import { contentToText } from './generate';
import {
  assertComposePayloadSize,
  buildComposeMessages,
  QUALITY_REPORT_COMPOSE_SYSTEM,
} from './quality';
import {
  formatZodError,
  LlmGenerateRequestSchema,
  MapDetectionBoxesRequestSchema,
  MutationPrepareRequestSchema,
  parseRequest,
  QualityReportComposeRequestSchema,
} from './schemas';

describe('extractJsonObject：LLM 文本解析', () => {
  it('解析纯 JSON 对象', () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it('剥掉 markdown 围栏', () => {
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('剥掉无语言标注的围栏', () => {
    expect(extractJsonObject('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('从夹杂说明文字的响应中抓取 JSON', () => {
    expect(extractJsonObject('好的，结果如下：\n{"a": 1}\n希望有帮助')).toEqual({
      a: 1,
    });
  });

  it('贪婪匹配到最后一个 }（尾部有游离 } 时会解析失败）', () => {
    // Python 的 re.search(r"\{[\s\S]*\}") 同样是贪婪的，因此行为一致地返回空对象
    expect(extractJsonObject('{"a": {"b": 1}} 之后还有 }')).toEqual({});
  });

  it('JSON 之后有说明文字时仍能解析', () => {
    expect(extractJsonObject('结果如下：\n{"a": 1}')).toEqual({ a: 1 });
  });

  it('嵌套对象直接解析成功', () => {
    expect(extractJsonObject('{"a": {"b": 1}}')).toEqual({ a: { b: 1 } });
  });

  it('数组响应返回空对象（只接受对象）', () => {
    expect(extractJsonObject('[1, 2, 3]')).toEqual({});
  });

  it('完全无 JSON 时返回空对象', () => {
    expect(extractJsonObject('抱歉我无法完成')).toEqual({});
  });

  it('空输入返回空对象', () => {
    expect(extractJsonObject('')).toEqual({});
  });

  it('JSON 语法错误时返回空对象而不抛异常', () => {
    expect(extractJsonObject('{"a": }')).toEqual({});
  });

  it('null 字面量返回空对象', () => {
    expect(extractJsonObject('null')).toEqual({});
  });
});

describe('coerceNullStringFields', () => {
  it('把指定字段的 null 归一为空串', () => {
    expect(coerceNullStringFields({ a: null, b: 'x' }, ['a'])).toEqual({
      a: '',
      b: 'x',
    });
  });

  it('不触碰未列出的字段', () => {
    expect(coerceNullStringFields({ a: null }, ['b'])).toEqual({ a: null });
  });

  it('字段无值时保持缺失', () => {
    const result = coerceNullStringFields({}, ['a']);
    expect('a' in result).toBe(false);
  });

  it('空字段列表时原样返回', () => {
    const input = { a: null };
    expect(coerceNullStringFields(input, [])).toBe(input);
  });
});

describe('sanitizeUnicodeText：孤立代理清洗', () => {
  it('移除孤立高代理', () => {
    expect(sanitizeUnicodeText('a\uD800b')).toBe('ab');
  });

  it('移除孤立低代理', () => {
    expect(sanitizeUnicodeText('a\uDC00b')).toBe('ab');
  });

  it('保留合法代理对（emoji）', () => {
    expect(sanitizeUnicodeText('a😀b')).toBe('a😀b');
  });

  it('移除替换字符本身', () => {
    expect(sanitizeUnicodeText('a\ufffdb')).toBe('ab');
  });

  it('空输入返回空串', () => {
    expect(sanitizeUnicodeText('')).toBe('');
  });
});

describe('sanitizeJsonValue：递归清洗', () => {
  it('清洗嵌套对象与数组中的字符串', () => {
    expect(
      sanitizeJsonValue({ a: ['x\uD800', { b: 'y\ufffd' }] }),
    ).toEqual({ a: ['x', { b: 'y' }] });
  });

  it('清洗键名', () => {
    expect(sanitizeJsonValue({ 'k\uD800': 1 })).toEqual({ k: 1 });
  });

  it('数字与布尔原样保留', () => {
    expect(sanitizeJsonValue({ n: 1, b: true, z: null })).toEqual({
      n: 1,
      b: true,
      z: null,
    });
  });
});

describe('httpFromLlmError：错误分流', () => {
  it('4xx 上游错误映射为 400 并保留信息', () => {
    const err = httpFromLlmError(new Error('bad request'), 400);
    expect(err.status).toBe(400);
    expect(err.message).toBe('bad request');
  });

  it('提及 response_format 时映射为 400 并给出中文提示', () => {
    const err = httpFromLlmError(
      new Error('Unsupported parameter: response_format'),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('不支持结构化输出');
  });

  it('提及 json_schema 时同样映射为 400', () => {
    expect(httpFromLlmError(new Error('json_schema not supported')).status).toBe(400);
  });

  it('其它错误映射为 502', () => {
    const err = httpFromLlmError(new Error('连接超时'));
    expect(err.status).toBe(502);
    expect(err.message).toBe('连接超时');
  });

  it('502 信息截断到 500 字符', () => {
    const err = httpFromLlmError(new Error('x'.repeat(1000)));
    expect(err.status).toBe(502);
    expect(err.message).toHaveLength(500);
  });

  it('空错误信息回退到 llm_invoke_failed', () => {
    expect(httpFromLlmError(new Error('')).message).toBe('llm_invoke_failed');
  });

  it('返回 AnnotateHttpError 实例', () => {
    expect(httpFromLlmError(new Error('x'))).toBeInstanceOf(AnnotateHttpError);
  });
});

describe('filterPaths：候选路径过滤', () => {
  const candidates = [
    { relative_path: 'data/1.jpg', name: '1.jpg', parent: 'data', index: 0 },
    { relative_path: 'data/2.jpg', name: '2.jpg', parent: 'data', index: 1 },
  ];

  it('只保留候选列表中的路径', () => {
    expect(filterPaths(['data/1.jpg', 'data/9.jpg'], candidates)).toEqual([
      'data/1.jpg',
    ]);
  });

  it('反斜杠路径归一后匹配', () => {
    expect(filterPaths(['data\\1.jpg'], candidates)).toEqual(['data/1.jpg']);
  });

  it('保持输入顺序', () => {
    expect(filterPaths(['data/2.jpg', 'data/1.jpg'], candidates)).toEqual([
      'data/2.jpg',
      'data/1.jpg',
    ]);
  });

  it('非数组输入返回空数组', () => {
    expect(filterPaths('data/1.jpg', candidates)).toEqual([]);
    expect(filterPaths(null, candidates)).toEqual([]);
  });
});

describe('labelNamesOf', () => {
  it('提取非空标签名', () => {
    expect(
      labelNamesOf({
        project_id: 'p',
        name: '',
        modality: 'image',
        annotation_type: 'bbox',
        labels: [{ name: 'person' }, { name: '  ' }, { name: 'car' }],
      }),
    ).toEqual(['person', 'car']);
  });

  it('无项目快照返回空数组', () => {
    expect(labelNamesOf(null)).toEqual([]);
    expect(labelNamesOf(undefined)).toEqual([]);
  });
});

describe('dumpMutationOperation：完整字段集（对齐 Pydantic model_dump）', () => {
  const minimal = {
    relative_path: 'data/1.jpg',
    mutation_kind: 'patch_label' as const,
    targets: [{ by: 'all' as const }],
  };

  it('输出全部字段，未设值者为 null', () => {
    const dumped = dumpMutationOperation(minimal as never);
    expect(dumped).toMatchObject({
      relative_path: 'data/1.jpg',
      mutation_kind: 'patch_label',
      new_label_name: null,
      x: null,
      cx: null,
      points: null,
      keypoints: null,
      steps: null,
      turns: null,
      note: null,
    });
  });

  it('字段数量固定（不因输入而增减）', () => {
    const keys = Object.keys(dumpMutationOperation(minimal as never));
    // 与 MutationOperationSchema 的 28 个字段一一对应
    expect(keys).toHaveLength(28);
  });

  it('targets 递归展开并补齐字段', () => {
    const dumped = dumpMutationOperation(minimal as never);
    expect(dumped.targets).toEqual([
      {
        by: 'all',
        id: null,
        label_name: null,
        index: null,
        hint: null,
        granularity: null,
        language: null,
      },
    ]);
  });

  it('嵌套模型递归展开', () => {
    const dumped = dumpMutationOperation({
      ...minimal,
      points: [{ x: 0.1, y: 0.2 }],
      keypoints: [{ x: 0.3, y: 0.4, visibility: 1 }],
      steps: [{ description: 'd', conclusion: 'c' }],
      turns: [{ role: 'user', content: 'hi' }],
    } as never);

    expect(dumped.points).toEqual([{ x: 0.1, y: 0.2 }]);
    expect(dumped.keypoints).toEqual([{ x: 0.3, y: 0.4, visibility: 1 }]);
    expect(dumped.steps).toEqual([{ description: 'd', conclusion: 'c' }]);
    expect(dumped.turns).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('数字 0 不被误当作缺失', () => {
    const dumped = dumpMutationOperation({ ...minimal, start: 0 } as never);
    expect(dumped.start).toBe(0);
  });
});

describe('contentToText：LLM 内容抽取', () => {
  it('字符串原样返回', () => {
    expect(contentToText('hi')).toBe('hi');
  });

  it('内容块数组拼接 text 部件', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(
      'ab',
    );
  });

  it('数组中非 text 部件跳过', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'image' }])).toBe('a');
  });

  it('null / undefined 返回空串', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(undefined)).toBe('');
  });
});

describe('quality compose：payload 校验与消息构造', () => {
  it('小 payload 通过校验', () => {
    expect(() => assertComposePayloadSize({ a: 1 })).not.toThrow();
  });

  it('超过 512KB 抛 compose_payload_too_large', () => {
    const huge = { blob: 'x'.repeat(600_000) };
    expect(() => assertComposePayloadSize(huge)).toThrow('compose_payload_too_large');
  });

  it('消息含固定系统提示与 JSON 载荷', () => {
    const messages = buildComposeMessages({ metrics: { total: 5 } });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe(QUALITY_REPORT_COMPOSE_SYSTEM);
    expect(messages[1].content).toContain('【质量指标与发现 JSON】');
    expect(messages[1].content).toContain('"total": 5');
    expect(messages[1].content).toContain('请基于以上数据撰写完整 Markdown 质量报告。');
  });

  it('超过 48000 字符时截断并加提示', () => {
    const messages = buildComposeMessages({ blob: 'x'.repeat(60_000) });
    expect(messages[1].content).toContain('…（已截断）');
  });
});

describe('请求 schema：约束对齐', () => {
  it('llm-generate 的默认值', () => {
    const parsed = LlmGenerateRequestSchema.parse({ provider_id: 'p' });
    expect(parsed.temperature).toBe(0.3);
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.image_mime_type).toBe('image/jpeg');
    expect(parsed.system_prompt).toBe('');
  });

  it('llm-generate 拒绝越界的 temperature', () => {
    expect(() =>
      LlmGenerateRequestSchema.parse({ provider_id: 'p', temperature: 3 }),
    ).toThrow();
  });

  it('llm-generate 拒绝越界的 max_tokens', () => {
    expect(() =>
      LlmGenerateRequestSchema.parse({ provider_id: 'p', max_tokens: 999_999 }),
    ).toThrow();
  });

  it('mutation-prepare 要求 user_request 非空', () => {
    expect(() =>
      MutationPrepareRequestSchema.parse({ provider_id: 'p' }),
    ).toThrow();
    expect(() =>
      MutationPrepareRequestSchema.parse({ provider_id: 'p', user_request: '' }),
    ).toThrow();
  });

  it('map-detection-boxes 的默认值', () => {
    const parsed = MapDetectionBoxesRequestSchema.parse({ provider_id: 'p' });
    expect(parsed.use_vision).toBe(false);
    expect(parsed.label_strategy).toBe('map_each_box_to_label');
    expect(parsed.mime_type).toBe('image/jpeg');
    expect(parsed.boxes).toEqual([]);
  });

  it('quality compose 的 compose_payload 默认空对象', () => {
    expect(
      QualityReportComposeRequestSchema.parse({ provider_id: 'p' }).compose_payload,
    ).toEqual({});
  });

  it('provider_id 长度受限', () => {
    expect(() =>
      LlmGenerateRequestSchema.parse({ provider_id: 'x'.repeat(65) }),
    ).toThrow();
  });

  it('忽略多余字段（对齐 Pydantic extra=ignore）', () => {
    const parsed = LlmGenerateRequestSchema.parse({
      provider_id: 'p',
      unknown_field: 'whatever',
    });
    expect('unknown_field' in parsed).toBe(false);
  });

  it('parseRequest 对非法 JSON 给出中文提示', () => {
    try {
      parseRequest('{bad json', LlmGenerateRequestSchema);
      throw new Error('应当抛错');
    } catch (err) {
      expect(formatZodError(err as z.ZodError)).toBe('请求体不是合法 JSON');
    }
  });

  it('formatZodError 带字段路径', () => {
    try {
      parseRequest('{}', LlmGenerateRequestSchema);
      throw new Error('应当抛错');
    } catch (err) {
      expect(formatZodError(err as z.ZodError)).toContain('provider_id');
    }
  });
});

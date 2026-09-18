/**
 * 阶段 0 行为基线：预置 LLM 场景。
 *
 * 每个场景是「按顺序逐个消费的 assistant 轮次」。mock LLM 服务
 * (mockLlmServer.mjs) 对同一场景的每次 /chat/completions 调用消费一轮，
 * 因此 resume（客户端工具回传后再跑一轮）自然对应后续轮次。
 *
 * 轮次结构：
 *   { text?, reasoning?, toolCalls?: [{ id, name, args, argFragmentSize? }] }
 *
 * argFragmentSize 控制 tool_call arguments 的分片粒度，用于驱动增量流式解析
 * （提案拦截器会逐片累积半截 JSON）。设为 0 表示一次性给出完整 args。
 */

/** 只读工具调用（SYNC，不会触发 tool_pending）。 */
const READ_TOOL_TURN = {
  text: '我先看一下工作区结构。',
  toolCalls: [
    {
      id: 'call_read_1',
      name: 'list_workspace_directory',
      args: { relative_dir: '' },
      argFragmentSize: 4,
    },
  ],
};

/**
 * 覆盖主要协议路径的场景集合。
 *
 * 命名即 gateway 路径段：base_url = `${mock}/scenario/<id>/v1`
 */
export const SCENARIOS = [
  {
    id: 'plain-text',
    description: '纯文本对话：只发 text_delta，无工具',
    turns: [
      { text: '你好，这是纯文本回复。' },
    ],
  },

  {
    id: 'reasoning',
    description: '带 reasoning_content：验证 reasoning_delta 与 text_delta 的分离',
    turns: [
      {
        reasoning: '用户只是打招呼，直接回应即可。',
        text: '你好，我是运行在 LR-Agent 内的模型。',
      },
    ],
  },

  {
    id: 'single-tool',
    description: '单只读工具调用：验证 tool_start/tool_result 与 ToolMessage 回灌',
    turns: [
      READ_TOOL_TURN,
      { text: '工作区已检查完毕。' },
    ],
  },

  {
    id: 'parallel-readonly',
    description: '同轮多个并行白名单只读工具：验证预取但事件仍串行',
    turns: [
      {
        text: '我同时看几处。',
        toolCalls: [
          {
            id: 'call_a',
            name: 'read_workspace_file',
            args: { relative_path: 'README.md' },
            argFragmentSize: 5,
          },
          {
            id: 'call_b',
            name: 'glob_workspace',
            args: { glob_pattern: '**/*.json' },
            argFragmentSize: 5,
          },
        ],
      },
      { text: '两处都看完了。' },
    ],
  },

  {
    id: 'proposal-write',
    description: '新建文件提案：验证 file_proposal_start/delta/file_proposal 与增量 args',
    turns: [
      {
        text: '我来创建报告文件。',
        toolCalls: [
          {
            id: 'call_write_1',
            name: 'write_workspace_file',
            // 长内容 + 小分片，专门驱动逐字 diff 卡片
            args: {
              relative_path: 'reports/summary.md',
              content:
                '# 汇总报告\n\n' +
                '- 共检查 12 个文件\n' +
                '- 发现 3 处待处理项\n\n' +
                '## 详情\n\n' +
                '第一项需要补充说明。\n' +
                '第二项需要复核标注。\n' +
                '第三项已完成。\n',
            },
            argFragmentSize: 7,
          },
        ],
      },
      { text: '报告提案已生成，请确认。' },
    ],
  },

  {
    id: 'proposal-edit',
    description: '局部替换提案：验证 file_edit_delta 的 oldDelta/newDelta',
    turns: [
      {
        text: '我改一下这段配置。',
        toolCalls: [
          {
            id: 'call_edit_1',
            name: 'str_replace_workspace_file',
            args: {
              relative_path: 'config/app.json',
              old_string: '  "timeout": 30,\n  "retries": 1\n',
              new_string: '  "timeout": 120,\n  "retries": 3\n',
            },
            argFragmentSize: 3,
          },
        ],
      },
      { text: '替换提案已生成。' },
    ],
  },

  {
    id: 'proposal-lr-agent-suppressed',
    description: '写入 .lr-agent 路径：拦截器应 suppress，不出卡',
    turns: [
      {
        toolCalls: [
          {
            id: 'call_suppressed',
            name: 'write_workspace_file',
            args: { relative_path: '.lr-agent/scratch.md', content: '内部草稿' },
            argFragmentSize: 4,
          },
        ],
      },
      { text: '内部草稿已处理。' },
    ],
  },

  {
    id: 'client-tool-pending',
    description: '客户端工具：验证 tool_pending 结束本轮，以及 resume 后续跑',
    turns: [
      {
        text: '我来发起自动标注。',
        toolCalls: [
          {
            id: 'call_annotate_1',
            name: 'auto_annotate',
            args: { user_request: '标注 data 下所有图片', paths: ['data/'] },
            argFragmentSize: 6,
          },
        ],
      },
      // 该轮次对应 resume（客户端工具执行完后回传结果）
      { text: '标注提案已生成，请检查后 Keep All。' },
    ],
  },

  {
    id: 'subagent',
    description: '子代理：验证 subagent_* 七类事件与父级 tool_result',
    turns: [
      {
        toolCalls: [
          {
            id: 'call_explore_1',
            name: 'explore_readonly',
            args: { query: '项目里有哪些配置文件', focus_path: 'config' },
            argFragmentSize: 8,
          },
        ],
      },
      // 子代理内部的 LLM 调用
      {
        text: '我先看 config 目录。',
        toolCalls: [
          {
            id: 'call_inner_1',
            name: 'glob_workspace',
            args: { glob_pattern: '*.json', relative_dir: 'config' },
            argFragmentSize: 6,
          },
        ],
      },
      { text: 'config 下有一个 app.json。' },
      // 父级拿到子代理结论后的收尾
      { text: '查阅完成：配置文件只有 config/app.json。' },
    ],
  },

  {
    id: 'tool-choice-any-fallback',
    description: '正文写工具伪代码但不真发 tool_call：验证 tool_choice="any" 兜底',
    turns: [
      // 第一轮：只给正文（会被强制重试）
      { text: '我会调用 auto_annotate(paths=["data/"]) 来完成标注。' },
      // 第二轮：tool_choice="any" 的非流式调用，返回真实 tool_call
      {
        toolCalls: [
          {
            id: 'call_forced_1',
            name: 'auto_annotate',
            args: { user_request: '标注 data 目录', paths: ['data/'] },
          },
        ],
      },
      { text: '已发起标注。' },
    ],
  },

  {
    id: 'multiple-rounds',
    description: '多轮工具调用：验证轮次推进与消息累积',
    turns: [
      {
        toolCalls: [
          {
            id: 'call_r1',
            name: 'describe_client_context',
            args: {},
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'call_r2',
            name: 'get_lr_agent_help',
            args: { topic: '标注' },
          },
        ],
      },
      { text: '两轮工具都完成了。' },
    ],
  },
];

/** 按 id 建索引，便于按名取用。 */
export const SCENARIOS_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

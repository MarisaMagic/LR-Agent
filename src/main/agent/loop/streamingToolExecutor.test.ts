/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { StreamingToolExecutor } from './streamingToolExecutor';

interface RunCall {
  index: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function makeExecutor(opts: {
  eligible?: (name: string) => boolean;
  record?: RunCall[];
}): StreamingToolExecutor {
  return new StreamingToolExecutor({
    isEligible: opts.eligible ?? (() => true),
    run: async (call) => {
      opts.record?.push(call);
      return `r:${call.name}`;
    },
  });
}

describe('StreamingToolExecutor', () => {
  it('后一个 index 出现时，前一个调用的参数视为完整并立即开跑', () => {
    const record: RunCall[] = [];
    const executor = makeExecutor({ record });

    executor.onChunk([
      {
        index: 0,
        id: 'a',
        name: 'read_workspace_file',
        argsFragment: '{"relative_path":"a.md"}',
      },
    ]);
    expect(record).toHaveLength(0);

    executor.onChunk([
      {
        index: 1,
        id: 'b',
        name: 'grep_workspace',
        argsFragment: '{"pattern":"x"}',
      },
    ]);
    expect(record).toHaveLength(1);
    expect(record[0].name).toBe('read_workspace_file');
    expect(record[0].args).toEqual({ relative_path: 'a.md' });
  });

  it('未命中白名单的工具不提前执行', () => {
    const record: RunCall[] = [];
    const executor = makeExecutor({
      eligible: (name) => name !== 'write_workspace_file',
      record,
    });

    executor.onChunk([
      {
        index: 0,
        name: 'write_workspace_file',
        argsFragment: '{"relative_path":"a.md"}',
      },
      { index: 1, name: 'grep_workspace', argsFragment: '{"pattern":"x"}' },
    ]);
    executor.startPending();

    expect(record.map((c) => c.name)).toEqual(['grep_workspace']);
  });

  it('参数 JSON 不完整时不提前执行，收尾也不补跑', () => {
    const record: RunCall[] = [];
    const executor = makeExecutor({ record });

    executor.onChunk([
      { index: 0, name: 'grep_workspace', argsFragment: '{"pattern":"x"' },
    ]);
    executor.onChunk([
      {
        index: 1,
        name: 'glob_workspace',
        argsFragment: '{"glob_pattern":"*.ts"}',
      },
    ]);
    executor.startPending();

    expect(record.map((c) => c.name)).toEqual(['glob_workspace']);
  });

  it('单个调用在 startPending 时才起步，getResult 可取回', async () => {
    const record: RunCall[] = [];
    const executor = makeExecutor({ record });

    executor.onChunk([
      {
        index: 0,
        id: 'solo',
        name: 'read_workspace_file',
        argsFragment: '{"relative_path":"b.md"}',
      },
    ]);
    expect(record).toHaveLength(0);

    executor.startPending();
    expect(record).toHaveLength(1);

    const result = executor.getResult('read_workspace_file', {
      relative_path: 'b.md',
    });
    expect(result).toBeDefined();
    await expect(result).resolves.toBe('r:read_workspace_file');
  });

  it('同名同参只执行一次（结果键去重）', () => {
    const record: RunCall[] = [];
    const executor = makeExecutor({ record });

    executor.onChunk([
      { index: 0, name: 'grep_workspace', argsFragment: '{"pattern":"dup"}' },
      { index: 1, name: 'grep_workspace', argsFragment: '{"pattern":"dup"}' },
    ]);
    executor.startPending();

    expect(record).toHaveLength(1);
  });

  it('未提前执行时 getResult 返回 undefined', () => {
    const executor = makeExecutor({});
    expect(
      executor.getResult('grep_workspace', { pattern: 'x' }),
    ).toBeUndefined();
  });
});

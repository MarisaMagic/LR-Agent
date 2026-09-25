/**
 * 流式并行工具执行器。
 *
 * 目标：在阶段 A（模型仍在流式吐字）时，**一旦某个只读工具的参数完整就立刻开跑**，
 * 从而把「模型生成时间」与「工具执行时间」重叠，压缩首字后到结果的延迟。
 *
 * 与 Claude Code `StreamingToolExecutor` 的差异（OpenAI 兼容协议的限制）：
 *   - Anthropic 有 `content_block_stop`，能精确知道某个 tool_use 块结束；
 *   - OpenAI 兼容流没有该信号，只能靠「**下一个 tool_call index 出现**」推断
 *     上一个调用参数已完整，流结束时再收尾。
 *   - 因此：同轮多个工具能真正重叠；单个（或最后一个）工具只能等到流结束才起步，
 *     与改动前的行为一致。
 *
 * 安全边界：只有调用方判定为 `eligible` 的工具才会被提前执行。调用方应只放行
 * **只读、无副作用、且不会被本轮五道过滤改变**的工具（即 `PARALLEL_SYNC_TOOLS`）。
 * 即便因截断/压缩导致本轮被丢弃，提前执行也只读，不产生副作用。
 *
 * 结果按 `(name, args)` 的规范化键缓存：stage B 用同一键取回，取不到则回退现场执行。
 * 键取自同一份原始 JSON 解析，键序稳定，因此可可靠命中。
 */

/** 流式 tool_call 分片（与 `LlmDelta.toolCallChunks` 同构）。 */
export interface ToolCallChunk {
  index: number;
  id?: string;
  name?: string;
  argsFragment?: string;
}

interface AccumEntry {
  id: string;
  name: string;
  argsRaw: string;
}

/** 结果缓存键：同名同参视为同一调用（只读工具下安全且节省重复执行）。 */
export function toolResultKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}\u0000${JSON.stringify(args)}`;
}

export interface StreamingToolExecutorOptions {
  /** 是否允许提前执行该工具。 */
  isEligible: (name: string) => boolean;
  /** 实际执行（应复用主循环的 invokeTool，保证错误语义一致）。 */
  run: (call: {
    index: number;
    id: string;
    name: string;
    args: Record<string, unknown>;
  }) => Promise<string>;
}

export class StreamingToolExecutor {
  private readonly byIndex = new Map<number, AccumEntry>();

  private readonly startedIndexes = new Set<number>();

  private readonly results = new Map<string, Promise<string>>();

  private maxIndex = -1;

  constructor(private readonly options: StreamingToolExecutorOptions) {}

  /** 喂入一批流式分片；自动把「已被更高 index 取代」的调用启动。 */
  onChunk(chunks: ToolCallChunk[]): void {
    for (const chunk of chunks) {
      const entry = this.byIndex.get(chunk.index) ?? {
        id: '',
        name: '',
        argsRaw: '',
      };
      if (chunk.id && !entry.id) entry.id = chunk.id;
      if (chunk.name && !entry.name) entry.name = chunk.name;
      if (chunk.argsFragment) entry.argsRaw += chunk.argsFragment;
      this.byIndex.set(chunk.index, entry);
      if (chunk.index > this.maxIndex) this.maxIndex = chunk.index;
    }
    for (const index of this.byIndex.keys()) {
      if (index < this.maxIndex) this.tryStart(index);
    }
  }

  /** 流结束时的收尾：启动所有尚未启动的合格调用（含最后一个/单个调用）。 */
  startPending(): void {
    for (const index of this.byIndex.keys()) this.tryStart(index);
  }

  /** 取回提前执行的结果；未提前执行时返回 undefined，由调用方回退执行。 */
  getResult(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> | undefined {
    return this.results.get(toolResultKey(name, args));
  }

  /** 已启动提前执行的调用数（测试/调试用）。 */
  get startedCount(): number {
    return this.startedIndexes.size;
  }

  private tryStart(index: number): void {
    if (this.startedIndexes.has(index)) return;
    const entry = this.byIndex.get(index);
    if (!entry || !entry.name || !this.options.isEligible(entry.name)) return;

    // 参数必须是**完整合法**的 JSON 对象；半截 JSON 一律不提前执行。
    let args: unknown;
    try {
      args = JSON.parse(entry.argsRaw);
    } catch {
      return;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;

    this.startedIndexes.add(index);
    const parsedArgs = args as Record<string, unknown>;
    const key = toolResultKey(entry.name, parsedArgs);
    if (this.results.has(key)) return;
    const promise = this.options.run({
      index,
      id: entry.id,
      name: entry.name,
      args: parsedArgs,
    });
    // 本轮可能因截断/压缩被丢弃而不消费该结果：挂一个空 catch 避免
    // 未来若 run 出现 rejection 时产生 unhandledRejection（当前 run 不抛）。
    promise.catch(() => {});
    this.results.set(key, promise);
  }
}

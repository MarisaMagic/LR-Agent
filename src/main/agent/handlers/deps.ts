/**
 * 运行时依赖容器。
 *
 * 把配置与可注入的依赖集中到一处，便于：
 *   - 测试时注入 `fetchImpl` 打 mock LLM
 *   - 独立模式下从环境变量装载配置
 *   - 后续阶段追加 MCP 客户端、图像桥等依赖
 */

import { loadAgentSettings, type AgentSettings } from '../config';
import { buildTools, type ToolDefinition } from '../tools/registry';

export interface RuntimeDeps {
  settings: AgentSettings;
  /** 注入点：测试用 mock，生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** LLM 请求超时（默认 120s，对齐 Python）。 */
  llmTimeoutMs?: number;
}

let cachedTools: Map<string, ToolDefinition> | null = null;

/**
 * 工具注册表单例。
 *
 * 保留单例而不是每次请求重建：工具定义是纯声明，不持有请求级状态。
 * （Python 侧每次请求重建是为了让 `pending_proposals` 缓存随请求结束失效；
 * Node 侧的提案登记在阶段 3 会放到请求级上下文里，不依赖工具实例。）
 */
export function toolRegistry(): Map<string, ToolDefinition> {
  if (!cachedTools) {
    cachedTools = new Map(buildTools().map((tool) => [tool.name, tool]));
  }
  return cachedTools;
}

/** 测试用：清空工具缓存（工具定义变更后需重建）。 */
export function resetToolRegistry(): void {
  cachedTools = null;
}

/** 构造默认依赖（独立模式与 utilityProcess 模式共用）。 */
export function createDefaultDeps(): RuntimeDeps {
  return {
    settings: loadAgentSettings(),
    fetchImpl: undefined,
    llmTimeoutMs: 120_000,
  };
}

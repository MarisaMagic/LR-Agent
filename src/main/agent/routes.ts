/**
 * Agent 运行时的回环 HTTP 路由表。
 *
 * 路由清单与 `docs/agent-protocol.md` §4 一一对应。阶段 1 全部为骨架
 * （返回 501），阶段 2 起逐个接入真实实现：
 *
 *   阶段 2 → `POST /agent/chat/stream`、`POST /agent/chat/cancel`
 *   阶段 6 → `POST /agent/mcp/probe`
 *   阶段 7 → 标注编排四个端点
 *
 * 已明确删除（当前无调用方）的路由**不在此表登记**：
 *   - `POST /agent/annotation/batch-prepare`
 *   - `POST /agent/annotation/map-heuristic`
 */

import type { RouteHandler } from './server';

/** 业务路由路径（不含方法），供测试与文档对照。 */
export const AGENT_API_PREFIX = '/api/v1';

export const AGENT_ROUTE_PATHS = {
  chatStream: `${AGENT_API_PREFIX}/agent/chat/stream`,
  chatCancel: `${AGENT_API_PREFIX}/agent/chat/cancel`,
  mcpProbe: `${AGENT_API_PREFIX}/agent/mcp/probe`,
  annotationMutationPrepare: `${AGENT_API_PREFIX}/agent/annotation/mutation-prepare`,
  annotationMapDetectionBoxes: `${AGENT_API_PREFIX}/agent/annotation/map-detection-boxes`,
  annotationLlmGenerate: `${AGENT_API_PREFIX}/agent/annotation/llm-generate`,
  qualityReportComposeStream: `${AGENT_API_PREFIX}/agent/annotation-quality/report/compose/stream`,
} as const;

const notImplemented: RouteHandler = () => ({ kind: 'not_implemented' });

/**
 * 构造路由表。
 *
 * @param overrides 已实现的路由处理函数，键为 `"<METHOD> <path>"`
 */
export function buildRoutes(
  overrides: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> {
  const routes: Record<string, RouteHandler> = {};

  routes[`POST ${AGENT_ROUTE_PATHS.chatStream}`] = notImplemented;
  routes[`POST ${AGENT_ROUTE_PATHS.chatCancel}`] = notImplemented;
  routes[`POST ${AGENT_ROUTE_PATHS.mcpProbe}`] = notImplemented;
  routes[`POST ${AGENT_ROUTE_PATHS.annotationMutationPrepare}`] =
    notImplemented;
  routes[`POST ${AGENT_ROUTE_PATHS.annotationMapDetectionBoxes}`] =
    notImplemented;
  routes[`POST ${AGENT_ROUTE_PATHS.annotationLlmGenerate}`] = notImplemented;
  routes[`POST ${AGENT_ROUTE_PATHS.qualityReportComposeStream}`] =
    notImplemented;

  return { ...routes, ...overrides };
}

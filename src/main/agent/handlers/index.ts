/**
 * 已实现路由的装配。
 *
 * 阶段 1 的 `routes.ts` 全部返回 501；本模块在它之上覆盖已实现的端点。
 * 阶段 3/6/7 会继续在此追加提案、MCP、标注编排的实现。
 */

import { AGENT_ROUTE_PATHS, buildRoutes } from '../routes';
import type { RouteHandler } from '../server';
import { createChatCancelHandler, createChatStreamHandler } from './chatStream';
import type { RuntimeDeps } from './deps';

/** 装配全部已实现路由。 */
export function buildImplementedRoutes(
  deps: RuntimeDeps,
): Record<string, RouteHandler> {
  return buildRoutes({
    [`POST ${AGENT_ROUTE_PATHS.chatStream}`]: createChatStreamHandler(deps),
    [`POST ${AGENT_ROUTE_PATHS.chatCancel}`]: createChatCancelHandler(),
  });
}

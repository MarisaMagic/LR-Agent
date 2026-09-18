/**
 * 主进程侧暴露给 Agent 运行时的能力实现。
 *
 * 这里的每个 handler 都在**主进程**执行，是运行时唯一能触达 Electron 能力的入口
 * （运行时是 utilityProcess，无法直接使用 nativeImage / BrowserWindow 等）。
 *
 * 实现原则：**能复用就复用**。文件写入直接调 `workspaceOperations.ts`，与渲染层
 * IPC 走同一段代码，因此授权根校验、路径约束与 `file-system:changed` 广播行为一致。
 *
 * 后续阶段会补充：图像处理（nativeImage）、标注文档读写、记忆、skills、终端。
 */

import { AGENT_CHANNELS, type AgentChannel } from './protocol';
import { RpcError, type RpcHandlers } from './bridge';
import {
  deleteWorkspaceTextFile,
  moveWorkspaceTextFile,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from '../workspace/workspaceOperations';

/** 断言 payload 是对象，避免 undefined 解构崩溃。 */
function asRecord(payload: unknown, channel: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') {
    throw new RpcError(channel, 'payload 必须是对象');
  }
  return payload as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  channel: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new RpcError(channel, `字段 ${key} 必须是字符串`);
  }
  return value;
}

/**
 * 构造主进程侧 handler 表。
 *
 * 只注册当前阶段已实现的能力；未注册的通道由 bridge 统一回
 * `unknown channel` 错误，便于快速定位漏实现的接缝。
 */
export function createMainRpcHandlers(): RpcHandlers {
  const handlers: RpcHandlers = {};

  handlers[AGENT_CHANNELS.ping] = () => ({ ok: true, ts: Date.now() });

  handlers[AGENT_CHANNELS.workspaceWriteTextFile] = (payload) => {
    const ch = AGENT_CHANNELS.workspaceWriteTextFile;
    const obj = asRecord(payload, ch);
    return writeWorkspaceTextFile({
      rootDir: requireString(obj, 'rootDir', ch),
      relativePath: requireString(obj, 'relativePath', ch),
      content: typeof obj.content === 'string' ? obj.content : '',
    });
  };

  handlers[AGENT_CHANNELS.workspaceReadTextFile] = (payload) => {
    const ch = AGENT_CHANNELS.workspaceReadTextFile;
    const obj = asRecord(payload, ch);
    return readWorkspaceTextFile({
      rootDir: requireString(obj, 'rootDir', ch),
      relativePath: requireString(obj, 'relativePath', ch),
    });
  };

  handlers[AGENT_CHANNELS.workspaceDeleteTextFile] = (payload) => {
    const ch = AGENT_CHANNELS.workspaceDeleteTextFile;
    const obj = asRecord(payload, ch);
    return deleteWorkspaceTextFile({
      rootDir: requireString(obj, 'rootDir', ch),
      relativePath: requireString(obj, 'relativePath', ch),
    });
  };

  handlers[AGENT_CHANNELS.workspaceMoveTextFile] = (payload) => {
    const ch = AGENT_CHANNELS.workspaceMoveTextFile;
    const obj = asRecord(payload, ch);
    return moveWorkspaceTextFile({
      rootDir: requireString(obj, 'rootDir', ch),
      relativePath: requireString(obj, 'relativePath', ch),
      newRelativePath: requireString(obj, 'newRelativePath', ch),
    });
  };

  return handlers;
}

/** 已实现通道清单，供热重载/自检时对照。 */
export function listImplementedChannels(): AgentChannel[] {
  return Object.keys(createMainRpcHandlers()) as AgentChannel[];
}

/**
 * 全局 Agent Skills catalog 前端服务：
 * 经主进程 IPC 扫描 ~/.agents/skills，带短 TTL 内存缓存，避免每次发消息都扫磁盘。
 */

import type { AgentSkillEntry } from '../../shared/agentTypes';

const CACHE_TTL_MS = 30_000;

type SkillsBridge = {
  electron?: {
    skills?: {
      listCatalog?: () => Promise<unknown>;
    };
  };
};

let cache: { value: AgentSkillEntry[]; loadedAt: number } | null = null;

/**
 * 加载全局 skills catalog。扫描失败或不可用时返回空数组（不阻塞消息发送）。
 */
export async function loadSkillsCatalog(): Promise<AgentSkillEntry[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const bridge = (window as Window & typeof globalThis & SkillsBridge)
    .electron?.skills;
  if (!bridge?.listCatalog) return [];

  try {
    const raw = await bridge.listCatalog();
    const entries = Array.isArray(raw)
      ? raw
          .filter(
            (e): e is AgentSkillEntry =>
              !!e &&
              typeof (e as AgentSkillEntry).name === 'string' &&
              typeof (e as AgentSkillEntry).description === 'string',
          )
          .map((e) => ({ name: e.name, description: e.description, scope: 'user' as const }))
      : [];
    cache = { value: entries, loadedAt: Date.now() };
    return entries;
  } catch {
    return [];
  }
}

/** 清空缓存（测试或 skill 目录变更后调用） */
export function clearSkillsCatalogCache(): void {
  cache = null;
}

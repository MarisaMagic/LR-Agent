/**
 * Fusion parity toggle. Set `window.__LR_AGENT_FUSION_PARITY__ = false` in devtools to use legacy pipeline.
 */
export function isAnnotationFusionParityEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as Window & { __LR_AGENT_FUSION_PARITY__?: boolean };
    if (typeof w.__LR_AGENT_FUSION_PARITY__ === 'boolean') {
      return w.__LR_AGENT_FUSION_PARITY__;
    }
  }
  return true;
}

export const ANNOTATION_SUB_AGENT_MAX_ROUNDS = 12;

/**
 * 确定性快路径：本地 detect → map API → finalize，跳过 ReAct 子 Agent。
 * DevTools: window.__LR_AGENT_DETERMINISTIC_SUB_IMAGE__ = false 回退 ReAct。
 */
export function isDeterministicSubImageFastPathEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as Window & { __LR_AGENT_DETERMINISTIC_SUB_IMAGE__?: boolean };
    if (typeof w.__LR_AGENT_DETERMINISTIC_SUB_IMAGE__ === 'boolean') {
      return w.__LR_AGENT_DETERMINISTIC_SUB_IMAGE__;
    }
  }
  return true;
}

/**
 * 方案 C：后端 ReAct + SSE，客户端仅执行 run_object_detection / finalize；map 在服务端。
 * DevTools: window.__LR_AGENT_BACKEND_SUB_IMAGE__ = false 回退客户端多轮 agent-turn。
 */
export function isBackendDrivenSubImageAgentEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as Window & { __LR_AGENT_BACKEND_SUB_IMAGE__?: boolean };
    if (typeof w.__LR_AGENT_BACKEND_SUB_IMAGE__ === 'boolean') {
      return w.__LR_AGENT_BACKEND_SUB_IMAGE__;
    }
  }
  return true;
}

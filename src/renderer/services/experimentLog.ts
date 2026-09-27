/**
 * 实验埋点（渲染层）。
 *
 * 事件经 `window.electron.experiment.log` 发往主进程写入 JSONL；日志未启用时
 * 主进程静默忽略，这里无需分支。任何异常都不得影响正常标注流程。
 *
 * 采集点见 `docs/experiments/bbox-eval-protocol.md` §6：
 * `image_open` / `image_save` / `ai_generate` / `preannot_run`。
 */

export interface ExperimentEventPayload {
  [key: string]: unknown;
}

let unavailable = false;

/** 追加一条实验事件（fire-and-forget）。 */
export function logExperimentEvent(
  type: string,
  payload: ExperimentEventPayload = {},
): void {
  if (unavailable) return;
  const api = window.electron?.experiment;
  if (!api?.log) {
    unavailable = true;
    return;
  }
  void api.log({ type, ...payload }).catch(() => {
    // 单次失败不永久禁用；IPC 层失败通常是窗口关闭时序问题。
  });
}

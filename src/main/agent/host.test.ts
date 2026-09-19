/**
 * @jest-environment node
 *
 * 只测**纯逻辑**（退避策略）。`host.ts` 的顶层会 import `electron`，
 * 因此用模块 mock 把它挡掉——本用例不触碰任何真实进程。
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  utilityProcess: { fork: jest.fn() },
}));

// eslint-disable-next-line import/first
import { computeRestartDelayMs, shouldGiveUpRestart } from './host';

describe('computeRestartDelayMs：指数退避', () => {
  it('第 1 次为基准延迟 500ms', () => {
    expect(computeRestartDelayMs(1)).toBe(500);
  });

  it('逐次翻倍', () => {
    expect(computeRestartDelayMs(2)).toBe(1000);
    expect(computeRestartDelayMs(3)).toBe(2000);
    expect(computeRestartDelayMs(4)).toBe(4000);
    expect(computeRestartDelayMs(5)).toBe(8000);
  });

  it('超过上限时封顶 10s', () => {
    expect(computeRestartDelayMs(6)).toBe(10_000);
    expect(computeRestartDelayMs(20)).toBe(10_000);
  });

  it('非正数按基准延迟处理（防御非法入参）', () => {
    expect(computeRestartDelayMs(0)).toBe(500);
    expect(computeRestartDelayMs(-3)).toBe(500);
  });

  it('序列单调不减', () => {
    const seq = [1, 2, 3, 4, 5, 6, 7].map(computeRestartDelayMs);
    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
  });
});

describe('shouldGiveUpRestart：重启预算', () => {
  it('前 4 次仍会重试', () => {
    for (const attempt of [1, 2, 3, 4]) {
      expect(shouldGiveUpRestart(attempt)).toBe(false);
    }
  });

  it('第 5 次达到上限', () => {
    expect(shouldGiveUpRestart(5)).toBe(true);
  });

  it('超过上限同样放弃', () => {
    expect(shouldGiveUpRestart(9)).toBe(true);
  });

  it('预算内总等待时间约 15.5s（5 次退避之和）', () => {
    const total = [1, 2, 3, 4].reduce(
      (sum, attempt) => sum + computeRestartDelayMs(attempt),
      0,
    );
    // 500 + 1000 + 2000 + 4000 = 7500ms（第 5 次是判定放弃、不再等待）
    expect(total).toBe(7_500);
  });
});

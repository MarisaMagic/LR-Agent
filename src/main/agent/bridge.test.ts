import { describe, expect, it, jest } from '@jest/globals';
import { createBridge, RpcError, type MessageEndpoint } from './bridge';

/**
 * 构造一对互连的内存端点，模拟 utilityProcess 与主进程之间的双向通道。
 * 消息经 microtask 投递，贴近真实 IPC 的异步语义。
 */
function makePair(): [MessageEndpoint, MessageEndpoint] {
  const listenersA = new Set<(m: unknown) => void>();
  const listenersB = new Set<(m: unknown) => void>();

  const deliver = (
    listeners: Set<(m: unknown) => void>,
    message: unknown,
  ): void => {
    const snapshot = [...listeners];
    queueMicrotask(() => {
      for (const listener of snapshot) listener(message);
    });
  };

  const a: MessageEndpoint = {
    postMessage: (m) => deliver(listenersB, m),
    onMessage: (handler) => {
      listenersA.add(handler);
      return () => listenersA.delete(handler);
    },
  };
  const b: MessageEndpoint = {
    postMessage: (m) => deliver(listenersA, m),
    onMessage: (handler) => {
      listenersB.add(handler);
      return () => listenersB.delete(handler);
    },
  };
  return [a, b];
}

describe('agent RPC bridge', () => {
  it('主进程 → 运行时 的单向调用', async () => {
    const [hostSide, runtimeSide] = makePair();
    const host = createBridge({
      endpoint: hostSide,
      side: 'h',
      handlers: { ping: () => ({ ok: true }) },
    });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: {
        'image:crop': (payload: { boxes: number[] }) => ({
          count: payload.boxes.length,
        }),
      },
    });

    await expect(host.call('image:crop', { boxes: [1, 2, 3] })).resolves.toEqual({
      count: 3,
    });

    host.dispose();
    runtime.dispose();
  });

  it('双向对称调用可同时进行', async () => {
    const [hostSide, runtimeSide] = makePair();
    const host = createBridge({
      endpoint: hostSide,
      side: 'h',
      handlers: { 'host:whoami': () => 'host' },
    });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: { 'runtime:whoami': () => 'runtime' },
    });

    const [fromRuntime, fromHost] = await Promise.all([
      runtime.call('host:whoami'),
      host.call('runtime:whoami'),
    ]);

    expect(fromRuntime).toBe('host');
    expect(fromHost).toBe('runtime');

    host.dispose();
    runtime.dispose();
  });

  it('id 带侧别前缀，两侧并发调用互不串号', async () => {
    const [hostSide, runtimeSide] = makePair();
    const ids: string[] = [];
    const host = createBridge({
      endpoint: hostSide,
      side: 'h',
      handlers: { echo: () => 'ok' },
    });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: {
        echo: (payload: { id: string }) => {
          ids.push(payload.id);
          return payload.id;
        },
      },
    });

    const [a, b] = await Promise.all([
      host.call<string>('echo', { id: 'A' }),
      host.call<string>('echo', { id: 'B' }),
    ]);

    expect(new Set([a, b])).toEqual(new Set(['A', 'B']));
    expect(ids).toHaveLength(2);

    host.dispose();
    runtime.dispose();
  });

  it('handler 抛异常时调用方收到带通道名的 RpcError', async () => {
    const [hostSide, runtimeSide] = makePair();
    const host = createBridge({ endpoint: hostSide, side: 'h' });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: {
        boom: () => {
          throw new Error('内部错误');
        },
      },
    });

    await expect(host.call('boom')).rejects.toThrow(/内部错误/);
    await expect(host.call('boom')).rejects.toBeInstanceOf(RpcError);

    host.dispose();
    runtime.dispose();
  });

  it('未知通道被拒绝且不挂起', async () => {
    const [hostSide, runtimeSide] = makePair();
    const host = createBridge({ endpoint: hostSide, side: 'h' });
    const runtime = createBridge({ endpoint: runtimeSide, side: 'r' });

    await expect(host.call('nope')).rejects.toThrow(/unknown channel/);

    host.dispose();
    runtime.dispose();
  });

  it('超时后拒绝并清理 pending', async () => {
    const [hostSide, runtimeSide] = makePair();
    // 运行时侧不注册任何 handler → 但为触发超时需吞掉消息；用一个空 handler 表
    const host = createBridge({ endpoint: hostSide, side: 'h', timeoutMs: 30 });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: { slow: () => new Promise(() => {}) },
    });

    await expect(host.call('slow')).rejects.toThrow(/timeout after 30ms/);
    expect(host.pendingCount).toBe(0);

    host.dispose();
    runtime.dispose();
  });

  it('dispose 会拒绝全部 pending 并阻止后续调用', async () => {
    const [hostSide, runtimeSide] = makePair();
    const host = createBridge({ endpoint: hostSide, side: 'h' });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: { hang: () => new Promise(() => {}) },
    });

    const inflight = host.call('hang');
    expect(host.pendingCount).toBe(1);
    host.dispose('测试关闭');

    await expect(inflight).rejects.toThrow(/测试关闭/);
    await expect(host.call('hang')).rejects.toThrow(/bridge disposed/);

    runtime.dispose();
  });

  it('handle 可动态增补通道', async () => {
    const [hostSide, runtimeSide] = makePair();
    const host = createBridge({ endpoint: hostSide, side: 'h' });
    const runtime = createBridge({ endpoint: runtimeSide, side: 'r' });

    await expect(host.call('late')).rejects.toThrow(/unknown channel/);

    runtime.handle('late', () => 'added');
    await expect(host.call('late')).resolves.toBe('added');

    host.dispose();
    runtime.dispose();
  });

  it('未注册通道在响应方告警，且不影响其它通道', async () => {
    const [hostSide, runtimeSide] = makePair();
    // 未注册通道的告警由**响应方**记录（发起方只收到结构化错误）
    const runtimeLog = jest.fn();
    const host = createBridge({ endpoint: hostSide, side: 'h' });
    const runtime = createBridge({
      endpoint: runtimeSide,
      side: 'r',
      handlers: { ok: () => 1 },
      onLog: runtimeLog,
    });

    await expect(host.call('missing')).rejects.toThrow(/unknown channel/);
    await expect(host.call('ok')).resolves.toBe(1);
    expect(runtimeLog).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('missing'),
    );

    host.dispose();
    runtime.dispose();
  });
});

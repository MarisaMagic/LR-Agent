# Agent 协议行为基线

迁移 Agent 编排到 Node 时，**最大的风险是协议静默漂移**：渲染层的 SSE 解析器对畸形分片是
`catch { // ignore }`，字段名或事件语义对不上不会报错，只会表现为「没有反应」。

本目录提供一套不依赖真实模型的复现工具，用同一组输入分别打 Python 与 Node 实现，
把产出归一化后逐事件 diff，作为迁移的硬性验收 gate。

## 组成

| 文件 | 作用 |
|---|---|
| `scenarios.mjs` | 预置场景：覆盖纯文本、推理增量、只读工具、并行工具、提案新建/编辑、`.lr-agent` 抑制、客户端工具 pending、子代理、`tool_choice="any"` 兜底、多轮 |
| `mockLlmServer.mjs` | OpenAI 兼容的 mock LLM 服务，按场景逐轮返回 canned 响应（含分片 tool_call arguments） |
| `captureSse.mjs` | 对目标 Agent 服务跑完所有场景，抓取并归一化 SSE 事件，落盘 |
| `normalizeSse.mjs` | 归一化：工具调用 id 按出现顺序替换为稳定占位符、对象键排序 |
| `diffSse.mjs` | 逐场景逐事件比较两份抓取结果，有差异则非零码退出 |

## 使用

### 1. 抓取基准（迁移前的 Python 实现）

```bash
# 起 mock LLM
node scripts/agent-baseline/mockLlmServer.mjs --port 8799

# 另一个终端：起 Python 服务（固定端口，便于被抓取）
cd vendor/local-agent
LR_AGENT_LOCAL_PORT=8765 python local_main.py

# 再一个终端：抓取
node scripts/agent-baseline/captureSse.mjs \
  --target http://127.0.0.1:8765/api/v1 \
  --label python \
  --out .baseline/python
```

> `captureSse.mjs` 会在缺少 `--mock` 时自动拉起 mock LLM 并在结束时关闭；
> 若你已手动起了 mock，传 `--mock http://127.0.0.1:8799` 复用它。

### 2. 抓取候选（迁移后的 Node 实现）

```bash
node scripts/agent-baseline/captureSse.mjs \
  --target http://127.0.0.1:<node-port>/api/v1 \
  --label node \
  --out .baseline/node
```

### 3. 对比

```bash
node scripts/agent-baseline/diffSse.mjs \
  --baseline .baseline/python \
  --candidate .baseline/node
```

差异存在时退出码为 1，可直接接入 CI。

## 归一化规则

同一输入在不同实现下，**只有以下字段会被抹平**，其余必须逐字一致：

- `toolCallId` / `innerToolCallId` → 按首次出现顺序替换为 `<tc:N>`
- `clientToolCalls[].toolCallId` / `toolCalls[].toolCallId` → 同上
- 对象键顺序 → 排序（不影响语义）

**不做**归一化的（即必须一致）：

- 事件类型与顺序
- 事件条数（含收尾的裸 `done` 帧）
- 所有文本内容、`arguments` 字符串、路径
- 字段的存在性与命名（含 `suggestedRelativePath` / `operation` / `title` 等派生字段）

## 夹具工作区

`captureSse.mjs` 会在 `.baseline/fixture-workspace/` 下创建固定的夹具文件
（`README.md`、`config/app.json`、`data/`），使只读工具的返回内容可复现。

## 注意事项

- 场景轮次是**按序消费**的，每次抓取前会 `POST /__mock/reset` 重置游标。若某场景轮次
  耗尽，mock 会返回 500 并提示重置。
- 客户端工具（`auto_annotate` / `mutate_annotation` / `start_terminal_command`）不会真的执行；
  `captureSse.mjs` 会伪造与渲染层同结构的 `client_tool_results` 触发 resume，从而覆盖
  resume 消息注入路径。
- 若某个场景在候选侧报错，会写出 `<id>.error.json`；diff 时该场景计为失败。

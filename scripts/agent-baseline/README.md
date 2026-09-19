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

### 1. 基准（已冻结，无需重新抓取）

`.baseline/python/` 是**迁移前从 Python 实现抓取并已入库的冻结基准**。
原 Python 实现（`vendor/local-agent`）已随迁移完成而删除，因此这份基准**无法重新生成**——
这正是它在阶段 0 就被提交入库的原因。

不要删除或改动 `.baseline/python/`；它是判断协议是否漂移的唯一参照。

### 2. 抓取候选（当前的 Node 实现）

```bash
# 起 mock LLM
node scripts/agent-baseline/mockLlmServer.mjs --port 8799

# 另一个终端：起 Node 运行时（独立模式，无需 Electron）
LR_AGENT_LOCAL_TOKEN=baseline-token LR_AGENT_LOCAL_PORT=8765 \
  npx ts-node src/main/agent/runtime.ts

# 再一个终端：抓取
node scripts/agent-baseline/captureSse.mjs \
  --target http://127.0.0.1:8765/api/v1 \
  --token baseline-token \
  --label node \
  --out .baseline/node
```

> `captureSse.mjs` 会在缺少 `--mock` 时自动拉起 mock LLM 并在结束时关闭；
> 若你已手动起了 mock，传 `--mock http://127.0.0.1:8799` 复用它。

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

## 已记录的差异

`diffSse.mjs` 里有 `KNOWN_DIVERGENCES` 表，用于记录**有意保留**的行为差异。
它支持两种粒度，且都**只豁免明确列出的内容**，其余任何偏差仍会导致 gate 失败
——避免「整场景跳过」让这个 gate 失效：

1. `extraEventTypes`：允许候选侧多出（基准侧没有）的**事件类型**
2. `fieldOverrides`：某事件类型下**指定字段**的差异被忽略（两侧同时剔除后再比对，
   其余字段、事件顺序与条数仍严格校验）

当前记录：

| 场景 | 豁免内容 | 原因 |
|---|---|---|
| `reasoning` | 候选侧多出的 `reasoning_delta` 事件 | Python 的 `langchain-openai` 1.2.2 不把 provider 的 `reasoning_content` 透出到 `additional_kwargs`，故从不发该事件；Node 直接读原始 delta，属能力增强，前端已完整消费 |
| `proposal-write` | `tool_result` 事件的 `result` 字段 | 提案免确认改造：文件写入由「等用户 Keep All 才落盘」改为「直接落盘 + 可撤销」，工具结果文案随之从「文件尚未写入磁盘…」改为「内容已直接写入磁盘（无需确认）…可撤销」 |
| `proposal-edit` | 同上 | 同上 |

新增豁免时必须同时更新 `docs/agent-protocol.md` 的「已记录的差异」小节，并在 PR 说明中给出理由。

可随时用负向测试验证 gate 未被削弱：篡改任一**非豁免**字段（如 `text_delta.content`）
或删除一个事件，diff 必须报错。

## 场景与实现阶段的对应

抓取覆盖 11 个场景。迁移过程中某些场景会因对应阶段尚未实现而失败，属预期：

| 场景 | 依赖 |
|---|---|
| `plain-text` / `reasoning` / `single-tool` / `parallel-readonly` / `multiple-rounds` / `client-tool-pending` / `tool-choice-any-fallback` | 阶段 2（循环主干 + 只读工具 + 异步客户端工具） |
| `proposal-write` / `proposal-edit` / `proposal-lr-agent-suppressed` | 阶段 3（提案流式拦截 + 写入类工具） |
| `subagent` | 阶段 6（`explore_readonly` 子代理） |

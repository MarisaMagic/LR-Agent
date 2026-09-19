# Agent 编排协议契约

> **本文档是 Agent 编排协议的单一真源。**
>
> Node 运行时（`src/main/agent/**`）必须与本文档描述的行为逐字对等。任何偏差都会导致
> 渲染层静默降级——`src/renderer/services/backendChatClient.ts` 的 SSE 解析对畸形分片是
> `catch { // ignore }`，协议对不上不会报错，只会「没有反应」，排查成本极高。
>
> 本文档描述的是**从 Python 实现迁移前的既成行为**（原 `vendor/local-agent`，已移除）。
> 它仍是对外契约的权威描述，不再指向具体实现语言。
>
> 变更本文档需要同时更新 `scripts/agent-baseline/` 下的 golden 用例。
>
> 各契约在代码中的落点：
> - SSE 序列化规则 → `src/main/agent/sse.ts` 的 `toSseDict`
> - 请求体/消息解析 → `src/main/agent/schemas.ts`
> - 工具循环 → `src/main/agent/loop/assistLoop.ts`
> - 提案流式拦截 → `src/main/agent/loop/proposalStreamer.ts`
> - 子代理 → `src/main/agent/subagent/exploreReadonly.ts`
> - 标注编排 → `src/main/agent/annotate/*`
> - system prompt 组装 → `src/main/agent/context/systemPrompt.ts`

---

## 1. 传输层

| 项 | 值 |
|---|---|
| 服务绑定 | `127.0.0.1`，随机空闲端口（迁移前由 Electron 主进程分配） |
| 鉴权 | `Authorization: Bearer <token>`，token 每次启动随机生成；`/health` 不需要鉴权 |
| 健康检查 | `GET /health` → 200 `{"status":"ok"}` |
| API 前缀 | `/api/v1` |
| SSE 媒体类型 | `text/event-stream` |
| CORS | 允许来源为 `http://localhost:1212`，禁止通配符 |

### 1.1 SSE 分帧

每个事件一帧，格式：

```
data: {json}\n\n
```

- JSON 使用 `ensure_ascii=False`（中文不转义）
- 只有 `data:` 行，**没有 `event:` 行**；事件类型靠 JSON 内的 `type` 字段分派
- 客户端按 `\n` 切分、`trim()`、`startsWith('data:')`、`slice(5).trim()` 后 `JSON.parse`

### 1.2 流收尾

流末尾**无条件**追加一帧**裸对象**（不是完整的 `StreamEventPayload` 序列化结果）：

```
data: {"type": "done"}\n\n
```

注意：这一帧只有 `type` 字段。客户端在收到 `done` / `error` / `tool_pending` 时即终止读取。

### 1.3 取消语义

- 客户端**当前不使用**服务端取消端点，走本地 `AbortController`（`src/renderer/services/agentJobRegistry.ts` 的 `stopJob`）
- `POST /agent/chat/cancel` 仍保留，body `{"client_job_id": str}` → `{"ok": true}`
- 取消检查点遍布主循环与子代理循环；取消后流仍会走到收尾发 `done`

---

## 2. SSE 事件契约

### 2.1 字段序列化规则

字段名在 Python 内部为 snake_case，输出到 SSE 时按下列规则转换。**核心规则：仅当值
`is not None` 时才写入该字段**（空字符串 `""` 需要写入）。

| 内部字段 | SSE 输出名 | 条件 |
|---|---|---|
| `type` | `type` | 始终输出 |
| `content` | `content` | |
| `stage` | `stage` | |
| `status` | `status` | |
| `detail` | `detail` | |
| `proposal` | `proposal` | Node 侧不发射 |
| `summary` | `summary` | |
| `summary_up_to_message_id` | `summaryUpToMessageId` | Node 侧不发射 |
| `token_estimate` | `tokenEstimate` | Node 侧不发射 |
| `tool_call_id` | `toolCallId` | |
| `name` | `name` | |
| `arguments` | `arguments` | 字符串（pretty JSON），见 2.4 |
| `result` | `result` | |
| `message` | `message` | Node 侧不发射 |
| `image_path` | 见下 | |
| `mode` | 见下 | |
| `old_path` | 见下 | |
| `domain` / `target` / `reason` | 同名 | Node 侧不发射 |
| `query` | `query` | |
| `focus_path` | `focusPath` | |
| `inner_tool_call_id` | `innerToolCallId` | |
| `old_delta` / `new_delta` | `oldDelta` / `newDelta` | |
| `client_tool_calls` | 见下 | |

**`image_path` 的条件重命名**：

```
type ∈ { file_proposal_start, file_proposal_delta, file_proposal, document_proposal }
    → suggestedRelativePath
否则
    → imagePath
```

**`mode` 的条件派生**：

```
先输出 data["mode"] = mode
再当 type ∈ { file_proposal_start, file_proposal_delta, file_proposal, document_proposal }
    → 额外输出 data["operation"] = mode（与 mode 同值）
```

**`old_path` 的条件输出**：仅当 `type ∈ { file_proposal_start, file_proposal }` 时输出为 `oldPath`。

**派生字段 `title`**：当 `type ∈ { file_proposal_start, file_proposal, document_proposal }` 时

- 若有 `summary` → `title = summary`（**且 `summary` 字段本身仍然存在**）
- 否则若有 `detail` → `title = detail`

**`client_tool_calls` 双写**：序列化为 camelCase 数组后，**同时**写入 `clientToolCalls` 和
`toolCalls` 两个键，值相同（同一份数组）。

```jsonc
// ClientToolCall 元素结构（注意 arguments 是对象，不是字符串）
{ "toolCallId": "...", "name": "...", "arguments": { } }
```

### 2.2 事件生产者边界

`StreamEvent` 在 TypeScript 侧是联合类型，但**并非全部由运行时发射**。实现时不要为渲染层
合成的事件写发射逻辑。

| 事件 | 生产者 |
|---|---|
| `preparing`、`text_delta`、`reasoning_delta`、`tool_start`、`tool_result`、`tool_pending`、`file_proposal_start`、`file_proposal_delta`、`file_edit_delta`、`file_proposal`、`subagent_*`、`done` | **运行时** |
| `awaiting_confirmation`、`terminal_approval`、`terminal_approval_done`、`terminal_output`、`annotation_progress`、`annotation_proposal` | **渲染层合成** |
| `error` | **两侧都会发射**：渲染层在 fetch 失败 / HTTP 非 2xx / body 为空时合成；运行时的 Assist 循环在**非取消**的真实故障（最典型是 LLM 请求失败）时也会发射，否则失败会被静默降级为正常结束 |
| `context_updated`、`route_decided` | 已声明但**全仓库无发射点**（死类型，仅类型与调试日志消费） |
| `document_proposal` | `@deprecated` 旧类型，运行时从不发射；历史消息加载时归一为 `file_proposal`。序列化特判保留以兼容旧数据 |
| `tool_calls_already_completed` | **内部信号**，被上层消费，**不出 SSE** |

### 2.3 逐事件契约

#### `preparing`

| 字段 | 说明 |
|---|---|
| `type` | `"preparing"` |
| `stage` | `"streaming"`（assist / chat 两条路径）；`"mcp"`（MCP 工具发现之前） |

语义：首 token 前的等待提示。TS 类型声明里还允许 `'summarize'` / `'build_messages'`，但运行时当前不发。

#### `text_delta`

| 字段 | 说明 |
|---|---|
| `type` | `"text_delta"` |
| `content` | 正文增量 |

来源：chunk 的 `content` 为字符串时直接取；为数组时取 `type === "text"` 的 part。

#### `reasoning_delta`

| 字段 | 说明 |
|---|---|
| `type` | `"reasoning_delta"` |
| `content` | 推理增量，取自 `chunk.additional_kwargs.reasoning_content` |

#### `tool_start`

| 字段 | 说明 |
|---|---|
| `type` | `"tool_start"` |
| `toolCallId` | 工具调用 id |
| `name` | 工具名 |
| `arguments` | **字符串**：`JSON.stringify(args, null, 2)`（pretty JSON） |

**关键时机**：`tool_start` 在**本轮 astream 全部结束后**才发（在 `execute_round` 阶段），
**不在 chunk 期间发**。被门禁/去重拦截的调用也会发 `tool_start`。

#### `tool_result`

| 字段 | 说明 |
|---|---|
| `type` | `"tool_result"` |
| `toolCallId` | 工具调用 id |
| `result` | 字符串，显示文本 |

**`result` 内容规则**：多数工具传 `format_tool_result_for_display(raw)`：

- raw 不是合法 JSON → 原样返回
- raw 是 JSON 但非对象 → 原样返回
- raw 是对象且有 `summary` → **只返回 `summary` 文本**
- 否则有 `message` → 返回 `message` 文本
- 否则原样返回

#### `tool_pending`

| 字段 | 说明 |
|---|---|
| `type` | `"tool_pending"` |
| `clientToolCalls` | `ClientToolCall[]` |
| `toolCalls` | 与 `clientToolCalls` 同值的别名 |

语义：暂停主循环，**立即结束当前 HTTP 轮次**（不再产出任何事件，但收尾的 `done` 仍会发）。
触发工具 = runner 为 `ASYNC` 的三个：`auto_annotate`、`mutate_annotation`、`start_terminal_command`。
发射前会先为每个调用各发一条 `tool_start`。

**注意：`tool_pending` 之后是否进入用户确认断点，取决于该工具是否免确认。**

| 工具 | 落盘方式 | 是否进入 `awaiting_confirmation` |
|---|---|---|
| `write_workspace_file` / `str_replace_workspace_file` / `delete_workspace_file` / `move_workspace_file` | 渲染层收到定稿的 `file_proposal`（`contentFinalized === true`）后**直接落盘** | 否 |
| `mutate_annotation`（标注编辑） | 渲染层自动落盘；工具结果报 `proposal_pending: false` | 否 |
| `auto_annotate`（标注生成） | 提案保留 `pending`，等用户 Keep All | **是** |
| `start_terminal_command` | 需聊天内批准 | 是（终端审批流程） |

免确认的依据是「结果可审阅性 × 错误代价」：文件 diff 可扫读、标注编辑是指令明确的定点修改，
两者都随时可通过改前快照撤销；而标注生成由模型推理产出、审阅需逐框看图、`replace_matching`
还会覆盖已有标注，因此保留确认。详见 `src/renderer/services/agentProposalApply.ts` 的
`selectAutoApplicableProposals`。

#### `subagent_start`

| 字段 | 说明 |
|---|---|
| `type` | `"subagent_start"` |
| `toolCallId` | 父级 `explore_readonly` 调用的 id |
| `query` | 查阅任务 |
| `focusPath` | 可选，仅在非空时输出 |

#### `subagent_text_delta`

| 字段 | 说明 |
|---|---|
| `type` | `"subagent_text_delta"` |
| `toolCallId` | 父级调用 id |
| `content` | 增量文本 |

#### `subagent_tool_start`

| 字段 | 说明 |
|---|---|
| `type` | `"subagent_tool_start"` |
| `toolCallId` | 父级调用 id |
| `innerToolCallId` | 子代理内部的调用 id |
| `name` | 工具名 |
| `arguments` | pretty JSON 字符串 |

#### `subagent_tool_result`

| 字段 | 说明 |
|---|---|
| `type` | `"subagent_tool_result"` |
| `toolCallId` | 父级调用 id |
| `innerToolCallId` | 子代理内部的调用 id |
| `result` | 截断到 4000 字符的显示文本 |
| `status` | `"done"` 或 `"error"`（由结果 JSON 的 `ok === false` 判定） |

#### `subagent_done`

| 字段 | 说明 |
|---|---|
| `type` | `"subagent_done"` |
| `toolCallId` | 父级调用 id |
| `summary` | 中文摘要 |
| `status` | `"done"` 或 `"error"` |

主循环收到后会把 `summary` 包装成父级 `tool_result` 后再发，并 append 父级 `ToolMessage`。

#### `file_proposal_start`

| 字段 | 说明 |
|---|---|
| `type` | `"file_proposal_start"` |
| `summary` | 显示路径 |
| `title` | 派生，等于 `summary` |
| `suggestedRelativePath` | 显示路径（由 `image_path` 重命名而来） |
| `detail` | 字符串：流式拦截时为 `"0"`；定稿补齐时为 `String(content.length)` |
| `mode` / `operation` | 仅 edit 类工具时输出 `"edit"`；write 类不输出 |

#### `file_proposal_delta`

| 字段 | 说明 |
|---|---|
| `type` | `"file_proposal_delta"` |
| `content` | 增量片段 |
| `suggestedRelativePath` | 显示路径 |
| `mode` / `operation` | 仅定稿补齐路径会带；流式拦截路径**不带** |

频率：**每个 chunk 最多一条**（不是每个字符）。`content` 未闭合时也照发已累积部分。

#### `file_edit_delta`

| 字段 | 说明 |
|---|---|
| `type` | `"file_edit_delta"` |
| `suggestedRelativePath` | 显示路径 |
| `oldDelta` | 可选，`old_string` 的增量 |
| `newDelta` | 可选，`new_string` 的增量 |

`oldDelta` 与 `newDelta` 至少一个非空；两者都无增量则**不发射**。同一 chunk 内两者的增量
合并成**一条**事件。

#### `file_proposal`（终态）

| 字段 | 说明 |
|---|---|
| `type` | `"file_proposal"` |
| `summary` | 标题 |
| `title` | 派生，等于 `summary` |
| `content` | 完整内容（失败补发时为空串） |
| `suggestedRelativePath` | 显示路径 |
| `mode` / `operation` | `"write"` / `"edit"` / `"delete"` / `"rename"` |
| `oldPath` | 仅重命名（rename）时输出 |
| `status` | 仅失败补发时输出 `"dismissed"` |

两个发射点：

1. **失败补发**：流式拦截器已出卡但工具执行报错 → `status="dismissed"`、`content=""`
2. **正常定稿**：`summary = title`、`content` 全量、`mode = operation`、`old_path`

#### `done`

| 字段 | 说明 |
|---|---|
| `type` | `"done"` |

运行时在流末尾无条件发送。渲染层在整轮（含 resume）结束时也会合成一个 `done`。

#### `error`

| 字段 | 说明 |
|---|---|
| `type` | `"error"` |
| `message` | 错误信息 |

**两个来源**：

1. **运行时**——Assist 循环的故障兜底外壳（`src/main/agent/loop/assistLoop.ts` 的 `streamAssist`）。
   内层循环抛出的异常（最典型是 LLM 请求失败）会被转成一条 `error` 事件。
   若不这样做，异常会被 SSE 层吞掉、客户端读到 EOF 后合成 `done`，用户只会看到回复被截断
   而没有任何提示。

   **取消不报错**：`isCancelled()` 为真或异常为 `AbortError` 时静默结束——渲染层会按
   Cancelled 处理，报错反而会出现「点了停止却弹错误」的干扰。

2. **渲染层**——fetch 失败 / HTTP 非 2xx / body 为空时合成。

### 2.4 `arguments` 字段的类型不统一（不要统一）

| 场景 | 类型 |
|---|---|
| `tool_start.arguments` | pretty JSON **字符串** |
| `subagent_tool_start.arguments` | pretty JSON **字符串** |
| `tool_pending.clientToolCalls[].arguments` | **对象** |

这是既成事实，逐字复刻时不要改成统一类型。

---

## 3. 请求体契约

### 3.1 `POST /api/v1/agent/chat/stream`

字段名为 **snake_case**（即 JSON 键名）。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `api_key` | string(≥1) | 是 | | 主模型 key |
| `base_url` | string(≥1) | 是 | | 主模型 base URL（末尾 `/` 会被裁掉） |
| `model` | string(≥1) | 是 | | 主模型名 |
| `supports_vision` | boolean | 否 | `false` | 视觉探针结果 |
| `aux_model` | string | 否 | `""` | 辅助模型（子代理查阅） |
| `aux_api_key` | string | 否 | `""` | |
| `aux_base_url` | string | 否 | `""` | 三者**皆非空**才生效，否则跟随主模型 |
| `messages` | `ChatMessageInput[]` | 是 | | 历史消息，见 3.2 |
| `user_content` | string(≥1) | 是 | | 本轮用户文本 |
| `system_prompt` | string? | 否 | `null` | **仅无工具（纯 chat）分支生效** |
| `context_summary` | string? | 否 | `null` | 见 3.3 |
| `context_summary_up_to_message_id` | string? | 否 | `null` | **运行时从不读取** |
| `client_context` | `ClientContextInput?` | 否 | `null` | 见 3.4 |
| `client_tool_results` | `ClientToolResult[]` | 否 | `[]` | resume 时携带，见 3.5 |
| `client_job_id` | string(1..64) | 是 | | 取消与事件注册键 |

**`has_tools` 判定**（决定走 Agent 分支还是纯 chat 分支）：

```
client_context 非空 AND (
     workspace_root 去空格后非空
  OR active_annotation_project_id 为真
  OR annotation_project_snapshot 非空
)
```

### 3.2 `ChatMessageInput`

| 字段 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `role` | `"user" \| "assistant" \| "system" \| "tool"` | 是 | |
| `content` | string | 否 | `""` |
| `message_id` | string? | 否 | `null` |
| `interaction_mode` | `"chat" \| "annotation"`? | 否 | `null` |
| `tool_calls` | `ChatToolCallInput[]`? | 否 | `null` |
| `tool_call_id` | string(1..128)? | 否 | `null` |

`ChatToolCallInput`：`{ id: string(1..128), name: string(1..128), args: object = {} }`

**消息转换规则**（顺序：主 SystemMessage → 可选摘要 SystemMessage → 历史消息）：

| role | 转换 |
|---|---|
| `user` | `HumanMessage(content)` |
| `assistant` | 有 `tool_calls` → `AIMessage(content, tool_calls)`；否则纯 `AIMessage(content)` |
| `tool` | **`tool_call_id` 为空时整条跳过**；否则 `ToolMessage(content, tool_call_id)` |
| `system` | `SystemMessage(content)` |

### 3.3 摘要注入

`context_summary` 作为**第二条 SystemMessage**注入，紧跟主系统提示词，内容前缀固定：

```
【此前对话摘要】
<summary 正文>
```

**去重完全在前端完成**：前端按会话的 `summaryUpToMessageId` 在消息列表中定位截断点，
只发送其后的消息。因此摘要覆盖点之前的原始消息被永久移出窗口，不会与摘要重复。
运行时**不使用** `context_summary_up_to_message_id`。

### 3.4 `ClientContextInput`

| 字段 | 类型 | 默认 |
|---|---|---|
| `workspace_root` | string? | `null` |
| `active_file_path` | string? | `null` |
| `active_relative_path` | string? | `null` |
| `project_directory_path` | string? | `null` |
| `active_annotation_project_id` | string? | `null` |
| `annotation_project_modality` | string? | `null` |
| `annotation_project_type` | string? | `null` |
| `agent_mode` | `"chat" \| "annotation"`? | `null` |
| `work_mode` | `"editor" \| "annotation"`? | `null` |
| `selected_annotation_id` | string? | `null` |
| `selected_annotation_ids` | string[] | `[]` |
| `annotation_project_snapshot` | `AnnotationProjectSnapshotInput?` | `null` |
| `mcp_server_url` | string? | `null` |
| `mcp_server_token` | string? | `null` |
| `mcp_servers` | `McpServerInput[]` | `[]` |
| `project_instructions` | string? | `null` |
| `memory_index` | string? | `null` |
| `workspace_memory_enabled` | boolean | `false` |
| `skills_catalog` | `SkillCatalogEntryInput[]` | `[]` |
| `proposal_ledger` | string? | `null` |
| `proposal_states` | `ProposalStateInput[]` | `[]` |

**`AnnotationProjectSnapshotInput`**

| 字段 | 类型 | 约束 |
|---|---|---|
| `project_id` | string | 必填，1..64 |
| `name` | string | `""` |
| `modality` | string | `""` |
| `annotation_type` | string | `""` |
| `labels` | object[] | `[]` |
| `detection_models` | object[] | `[]` |
| `project_directory_path` | string? | `null` |

**`SkillCatalogEntryInput`**：`{ name: string(1..128), description: string(≤512) }`

**`ProposalStateInput`**

| 字段 | 类型 | 默认 |
|---|---|---|
| `path` | string(≥1) | 必填 |
| `kind` | `"annotation" \| "file"` | `"annotation"` |
| `status` | `"pending" \| "applied" \| "dismissed" \| "undone"` | `"pending"` |
| `operation` | string? | `null` |
| `annotation_ids` | string[] | `[]` |

**`McpServerInput`**

| 字段 | 类型 | 默认 |
|---|---|---|
| `id` | string(1..64) | 必填 |
| `url` | string(≥1) | 必填 |
| `transport` | `"streamable_http" \| "sse"` | `"streamable_http"` |
| `headers` | `Record<string,string>` | `{}` |
| `disabled_tools` | string[] | `[]` |

### 3.5 `ClientToolResult`

| 字段 | 类型 |
|---|---|
| `tool_call_id` | string(1..128) |
| `name` | string(1..128) |
| `result` | string（JSON 序列化字符串） |

**resume 处理流程**：

1. 把 `tool_call_id` 记入「已完成」集合（后续同 id 调用会被去重）
2. 对每条结果做 `enrich_resume_tool_result`：
   - 仅当结果是合法 JSON 才处理
   - 当 `proposals_applied === true`（阶段为 `VERIFY`）→ 强制 `proposal_pending=false`、
     `file_written=true`，并写入「已应用」版 next_hint
   - 否则写入普通版 next_hint
3. 注入消息：
   - 若该 `tool_call_id` 已存在于历史 AIMessage 的 tool_calls 中 → 直接补一条 `ToolMessage`
   - 否则（客户端多执行了一个运行时没声明的调用）→ **补造**一条
     `AIMessage(content="", tool_calls=[{ id, name, args: { user_request } }])`，再补 `ToolMessage`

第 3 步的第二个分支是正确性关键：不补造会让模型报 `tool_call_id` 不匹配。

---

## 4. 端点清单

| 方法 | 路径 | 说明 | 迁移处置 |
|---|---|---|---|
| `POST` | `/api/v1/agent/chat/stream` | Assist SSE 流式对话 | 保留 |
| `POST` | `/api/v1/agent/chat/cancel` | 取消任务 | 保留 |
| `POST` | `/api/v1/agent/mcp/probe` | 测试连接 MCP Server | 保留 |
| `POST` | `/api/v1/agent/annotation/mutation-prepare` | 标注变更规划 | 保留 |
| `POST` | `/api/v1/agent/annotation/map-detection-boxes` | 检测框标签映射 | 保留 |
| `POST` | `/api/v1/agent/annotation/llm-generate` | 通用 LLM 生成代理 | 保留 |
| `POST` | `/api/v1/agent/annotation-quality/report/compose/stream` | 质量报告撰写（SSE） | 保留 |
| `POST` | `/api/v1/agent/annotation/batch-prepare` | 批量标注计划 | **删除**（无调用方） |
| `POST` | `/api/v1/agent/annotation/map-heuristic` | 启发式映射 | **删除**（无调用方） |
| `GET` | `/health` | 健康检查 | 保留（阶段 9 可去） |

---

## 5. 工具注册表

### 5.1 执行器分类（单一真源）

| Runner | 语义 | 执行位置 |
|---|---|---|
| `SYNC` | 本轮在运行时内同步执行完毕 | 运行时 |
| `PROPOSAL` | 运行时校验并生成提案事件，**Electron 在提案定稿后直接落盘**（免确认，可撤销） | 运行时生成提案 / Electron 落盘 |
| `ASYNC` | 暂停循环，由 Electron 执行后 resume；是否进入用户确认断点见 §2.3 的 `tool_pending` | Electron |

**迁移后应收归为单一真源**：当前分类在三处手写镜像（Python `tool_registry_meta.py`、
`src/shared/agentToolKinds.ts`、`src/shared/agentTypes.ts` 的 `CLIENT_TOOL_NAME_SET`），
必须收敛为一处，避免漂移。

### 5.2 18 个内置工具

#### 只读检索类（SYNC，6 个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `read_workspace_file` | `relative_path: string = ""`、`start_line: int?`、`end_line: int?` | 带行号前缀的文本（`    12|code`，6 位右对齐） |
| `grep_workspace` | `pattern: string`、`path: string = ""`、`glob_pattern: string = "*"`、`case_insensitive: bool = false` | `path:line: content` 文本 |
| `glob_workspace` | `glob_pattern: string`、`relative_dir: string = ""` | 文件路径列表 |
| `list_workspace_directory` | `relative_dir: string = ""` | `name | kind | relativePath` |
| `read_document_file` | `relative_path: string = ""` | PDF / DOCX 正文 |
| `read_file_annotation` | `relative_path: string`、`annotation_offset: int = 0`、`annotation_limit: int = 200` | 标注 JSON，超 40k 截断 |

#### 视觉类（SYNC，1 个）

| 工具 | 参数 | 说明 |
|---|---|---|
| `read_image_for_vision` | `relative_path: string = ""` | 需 `provider_is_vision`，否则返回中文拒绝文案；结果含内部标记 `__vision_image_path__`，由调度层剥离并注入附图 |

#### 元信息类（SYNC，4 个）

| 工具 | 参数 |
|---|---|
| `get_account_summary` | 无 |
| `get_lr_agent_help` | `topic: string?` |
| `describe_client_context` | 无 |
| `describe_annotation_project` | 无 |

#### 提案写入类（PROPOSAL，4 个）

| 工具 | 参数 |
|---|---|
| `write_workspace_file` | `relative_path: string(≥1)`、`content: string` |
| `str_replace_workspace_file` | `relative_path: string(≥1)`、`old_string: string(≥1)`、`new_string: string`、`replace_all: bool = false` |
| `delete_workspace_file` | `relative_path: string(≥1)` |
| `move_workspace_file` | `relative_path: string(≥1)`、`new_relative_path: string(≥1)` |

`str_replace` 的匹配语义：`old_string` 必须在文件中**唯一出现**，否则报错；`replace_all=true`
时替换全部出现。

落盘复用 `src/main/workspace/workspaceWrite.ts`，其安全语义比 Python 侧更严（额外含
`realpath` 符号链接逃逸检测与授权根校验）。

#### 子代理（SYNC 特例，1 个）

| 工具 | 参数 |
|---|---|
| `explore_readonly` | `query: string(≥1)`、`focus_path: string?` |

#### 客户端工具（ASYNC 存根，2 个）

| 工具 | 参数 |
|---|---|
| `auto_annotate` | `user_request: string(≥1)`、`paths: string[]?`、`all_files: bool?`、`scope_hint: string?`、`write_mode: string?`、`conf_threshold: float? (0..1)`、`iou_threshold: float? (0..1)`、`model_id: string?`、`include_classes: string[]?`、`exclude_classes: string[]?`、`use_vision_mapping: bool?` |
| `mutate_annotation` | `user_request: string(≥1)`、`paths: string[]?`、`annotation_ids: string[]?` |

**注意**：这两个工具在运行时侧**没有执行体**，注册的是永远不会被本地调用的 stub。真正执行在
`src/renderer/services/agentJobRegistry.ts`。

> 另有 `start_terminal_command`（ASYNC），由本地 MCP Server
> （`src/main/mcp/server.ts`）暴露，不在上述 18 个内置工具内。

### 5.3 工具集分组

| 集合 | 内容 |
|---|---|
| `FULL_TOOL_SET` | 14 个：全部只读 + 全部提案写入 + 2 个标注客户端工具 |
| `WRITE_TOOL_NAMES` | `auto_annotate`、`mutate_annotation`、4 个提案写入工具 |
| `ASK_TOOL_SET` | `FULL_TOOL_SET − WRITE_TOOL_NAMES`（纯只读） |
| `LIGHT_TOOL_SET` | 只读 + 提案写入（**无标注工具**），用于编辑器 / 纯工作区 |

**工具集选择规则**：

```
has_context = has_project_snapshot OR is_editor OR has_workspace

agent_mode !== "annotation"  →  has_context ? ASK_TOOL_SET : ∅
has_project_snapshot && !is_editor  →  FULL_TOOL_SET
is_editor || has_workspace  →  LIGHT_TOOL_SET
否则  →  ∅
```

附加裁剪：`work_mode === "editor"` 时额外剔除全部标注工具。

**工具列表按名称排序后固定**。阶段门禁**不在 bind 期增删工具**，改由执行层
`check_call_allowed` 拦截——目的是让 tools 前缀跨阶段保持一致以命中 LLM 前缀缓存。

### 5.4 统一工具结果结构

`build_tool_result` 产出的 JSON：

```jsonc
{
  "ok": boolean,
  "tool": string,
  "status": string,
  "summary": string,
  "file_written": boolean,   // 默认 false
  "proposal_pending": boolean, // 默认 false
  // ...额外字段
}
```

`format_tool_result_for_display`（用于 `tool_result` 事件与主循环 `ToolMessage` 回灌）：
有 `summary` 则只返回 `summary`；否则有 `message` 返回 `message`；否则原样返回。

**易错点**：主循环回灌用**显示文本**；子代理内部回灌用**原文**。二者不一致，不要统一。

**分支赋值语义**（容易写错）：`display_result` 的初值是**原始结果文本**，只有特定分支才覆盖它：

| 工具类别 | 条件 | display |
|---|---|---|
| `read_image_for_vision` | 提取到图片路径 | 剥离内部标记后格式化 |
| `read_image_for_vision` | 未提取到路径 | **原始文本** |
| `FILE_PROPOSAL_TOOLS` | 提取到 `__doc_proposal__` | 格式化（实际等于 `summary`） |
| `FILE_PROPOSAL_TOOLS` | 未提取到（工具报错） | **原始完整 JSON** |
| 其它 | — | 格式化 |

关键在第 4 行：提案工具失败时回灌的是**完整 JSON**而非 `summary`。因为 Python 的 `elif`
分支只在 `doc_proposal` 存在时才赋值 `display_result`，否则沿用初值。

**JSON 序列化必须用 Python 的 `json.dumps` 语义**：默认分隔符是 `(', ', ': ')`（逗号与冒号
后都有空格），而 JavaScript 的 `JSON.stringify` 不插空格：

```
Python: {"ok": false, "tool": "x"}
JS    : {"ok":false,"tool":"x"}
```

多数情况下该差异会被 `format_tool_result_for_display` 折叠掉（只取 `summary`），但上面第 4 行
那条路径会**原样暴露**，导致 `result` 字段与基准不一致。实现见 `src/main/agent/json.ts` 的
`pythonJsonDumps`。

注意：带缩进（`indent=2`）时 Python 的元素分隔符变成 `,`（无空格），键分隔符仍是 `': '`——
这与 `JSON.stringify(value, null, 2)` **一致**，故缩进场景（如 `tool_start.arguments`）
可直接用 `JSON.stringify`，只有紧凑场景需要 `pythonJsonDumps`。

**关键规则：工具可执行性以「工具集」为准，而非「注册表」。**

`describe_client_context` 与 `get_account_summary` 在注册表中存在，但被模式路由刻意排除在主
Agent 工具集之外（理由见 §5.3 注释）。Python 侧 `fn_map` 只包含**筛选后**的工具，因此越界调用
返回：

```json
{"ok": false, "tool": "<name>", "status": "error", "summary": "未知工具: <name>"}
```

注意这是**裸 JSON**，不经 `buildToolResult`，因此不含 `file_written` / `proposal_pending`。

若实现时误用全量注册表，会同时造成两处偏差：

1. 越界调用从「未知工具」变成真实执行
2. `tool_choice="any"` 兜底**错误触发**——它的前置条件之一正是「该工具在当前工具集内」

### 5.5 免确认落盘（提案免确认改造）

**提案事件（`file_proposal` / `annotation_proposal`）在运行时侧仍是统一的「变更描述」，
但渲染层对它们的处理分两档。**

| 提案来源 | 渲染层行为 | 依据 |
|---|---|---|
| `file_proposal`（4 个写入工具） | 等 `contentFinalized === true` 后**直接落盘** | diff 可扫读、指令明确、错误代价低 |
| `annotation_proposal` 且 `sourceKind === 'mutation'` | **直接落盘** | 指令明确的定点修改（改标签/删框/改内容），有改前快照兜底 |
| `annotation_proposal` 且来源为批量标注 | 保留 `pending`，**等用户 Keep All** | 模型推理产出、审阅需逐框看图、`replace_matching` 会覆盖已有标注 |

实现要点（`src/renderer/services/agentProposalApply.ts` 的 `selectAutoApplicableProposals`）：

1. **必须等 `contentFinalized`**：`file_proposal_start` 阶段 `content` 是空串且
   `contentFinalized` 为 false（内容随后由 `file_proposal_delta` 流式补齐）。
   此时落盘会写入空内容 / 半截内容。缺失该字段的历史数据一律视为未定稿（保守）。
2. **`sourceKind` 优先，内容推断回退**：历史数据可能缺 `sourceKind`，此时按提案内容推断
   （只含 `delete`/`patch` 即标注编辑），与 `agentChatStore` 设置 `sourceKind` 用的是
   **同一份实现**（`pipelineKinds.ts` 的 `inferAnnotationProposalKind`）。
3. **失败保持 `pending`**：写盘失败时不静默吞掉，block 仍为待确认态，卡片可用
   Keep All / Undo 手动处理；同时标记该 ref 以免流式期间反复重试刷提示。
4. **撤销是一等公民**：每次落盘前都会捕获改前快照（`captureProposalCheckpoint`），
   因此可直接撤销。撤销入口两处：消息的 Files Changed 汇总卡右上角、消息工具栏。

**因此 `awaiting_confirmation` 只由标注生成（`auto_annotate`）与终端审批触发。**

### 6.0 已记录的差异

以下差异是**有意保留**的，不属于回归。`scripts/agent-baseline/diffSse.mjs` 的
`KNOWN_DIVERGENCES` 支持两种粒度，且都只豁免**明确列出的内容**（其余字段、事件顺序与
条数仍严格校验），因此任何偏差仍会导致 gate 失败：

1. `extraEventTypes`：允许候选侧多出某类事件
2. `fieldOverrides`：忽略某事件类型下指定字段的差异

| 场景 | 豁免内容 | 原因 |
|---|---|---|
| `reasoning` | 候选侧多出的 `reasoning_delta` 事件 | Python 用的 `langchain-openai` 1.2.2 不把 provider 的 `reasoning_content` 透出到 `additional_kwargs`，因此 `stream_adapter.py` 的该分支从不触发。Node 侧直接读原始 delta，正常透出。这是**能力增强**（前端 `agentChatStore` 已完整消费该事件），保留而不回退 |
| `proposal-write` / `proposal-edit` | `tool_result` 事件的 `result` 字段 | 见 §5.5 免确认落盘：文件写入不再等用户 Keep All，工具结果文案相应由「文件尚未写入磁盘；用户确认后才会落盘」改为「已直接写入磁盘（无需确认），用户可撤销」 |

---

## 6. 工具循环行为

### 6.1 轮次与预算

| 配置 | 默认 |
|---|---|
| 主循环最大工具轮次 | 30 |
| 子代理最大工具轮次 | 12 |

轮次预算耗尽时，追加一条 `HumanMessage`（内容为「工具调用预算已用完。请基于以上进展直接
给出最终回答，不要再调用工具。」），再跑一次**不带工具**的调用产出最终回答。

### 6.2 单轮流程

```
yield preparing(stage="streaming")
llm_bound = bind_tools(llm, tools)

for round_idx in 0..max_tool_rounds:
    if cancelled: return

    interceptor = new ProposalStreamInterceptor(client_context)   // 每轮新建

    # 阶段 A：单次 astream
    for chunk in astream(llm_bound, messages):
        if cancelled: return
        yield text_delta / reasoning_delta
        yield from interceptor.on_chunk(chunk)
        gathered = merge(gathered, chunk)

    if gathered is None: break
    full_text = 累积的正文

    # 阶段 B：执行本轮
    for ev in execute_round(gathered, full_text, messages, interceptor):
        if ev.type == INTERNAL_ALREADY_COMPLETED: continue
        if ev.type == "tool_pending": yield ev; return      // 结束 HTTP 轮次
        yield ev

    if had_tool_call: continue

    # 阶段 C：无 tool call
    if round_idx == 0 and not is_resume and vision.should_load() and not vision_bootstrapped:
        yield from vision.try_fallback(messages)
        vision_bootstrapped = true
        continue
    break
else:
    # 预算耗尽
    强制无工具收官
```

**chunk 累积**：靠增量合并（拼接 `content`、合并 `tool_calls` 分片、取最后非空的
`additional_kwargs`），累积成完整的 assistant 消息后读取其 `tool_calls`。

### 6.3 `execute_round` 的五道过滤

按顺序：

1. **调用规整化**：丢弃 name 为空的调用；丢弃 id 已在「已完成」集合中的调用；无 id 时生成
   `tool-{12位随机}`；args 非法时置 `{}`
2. **同轮顺序不变量**：若本轮含标注写入工具（`auto_annotate` / `mutate_annotation`），则把
   同轮的所有工作区写入工具改为 `phase_blocked` 错误反馈（保证「先标注后写报告」）
3. **阶段门禁**：`gating_enabled` 时逐调用校验（见 6.5）
4. **同轮多 `auto_annotate` 合并**：paths 去重合并、`all_files` 取或、`write_mode` 只要有一个
   `replace_matching` 就取之；其余调用回 `coalesced` 反馈。`mutate_annotation` **不合并**
5. **同批异步去重**：`scope_key = (name, 提取的 paths)`，重复者回 `duplicate_call` 反馈

之后分类执行：

- **并行只读白名单**（`get_lr_agent_help`、`describe_annotation_project`、
  `read_file_annotation`、`read_workspace_file`、`grep_workspace`、`glob_workspace`、
  `list_workspace_directory`、`read_document_file`）用 `Promise.all` **预取结果**，再按原顺序
  逐个发事件——**事件顺序仍是串行的**
- `explore_readonly` 单独并发执行并合并事件流
- 其余 SYNC 逐个串行执行（每个之前检查取消）
- ASYNC 收集后统一发 `tool_pending`

### 6.4 去重机制

- 常量文案：`该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。`
- 写入时机：resume 时把 `client_tool_results` 的 `tool_call_id` 记入已完成集合
- 命中效果：该调用被丢弃，但会为它补一条 `ToolMessage`（`status="already_completed"`），
  并发内部信号，让循环继续下一轮、模型自行总结
- **同名新调用（新 id）不受影响**

### 6.5 阶段门禁

`derive_task_phase(proposal_states)` 是无状态纯函数，每次请求重推：

| 条件 | 阶段 |
|---|---|
| 无 `proposal_states` | `null`（不启用门禁） |
| 存在 `kind="annotation" && status="pending"` | `AWAIT_CONFIRM` |
| 存在 `kind="annotation" && status="applied"` | `VERIFY` |
| 其余 | `null` |

`gating_enabled` 仅在 `AWAIT_CONFIRM` / `VERIFY` 时为真。

拦截规则：

- **`AWAIT_CONFIRM`**：禁止全部标注写入工具 + 全部工作区写入工具
- **`VERIFY`**：禁止对已 applied 路径重复 `auto_annotate`（`all_files=true`、未指明 paths、
  paths 有交集均拦）；`mutate_annotation` 要求指明 paths 或 annotation_ids，定向修正放行

被拦调用走 `_yield_blocked_call`：发 `tool_start` + `tool_result`（`status="phase_blocked"`），
并 append 对应 `ToolMessage`，循环继续。

注意：`SCAN` / `ANNOTATE` / `REPORT` 三个阶段目前**仅语义标记**，不参与拦截。

### 6.6 `tool_choice="any"` 强制兜底

触发条件（须全部满足）：

- 本请求内重试次数 < 1
- 本轮**没有**真实 tool_calls
- 正文经正则命中某个 **ASYNC** 工具名（形如 `name(`）
- 该工具在当前工具集中
- 门禁允许该调用

实现：用 `tool_choice="any"` 发起**非流式**调用，返回的 `AIMessage` 保留已流式输出的正文，
使后续 `ToolMessage` 的 id 有归属。失败则按普通空轮处理。

背景：部分模型会在正文里写工具伪代码而不真正发起 tool_call。

### 6.7 取消

- 取消通过 `AbortSignal` 贯穿（Python 侧原为进程内 `asyncio.Event`）
- 检查点：每轮开始、astream 中、每个工具执行前、子代理每轮与每次内层调用前
- 取消后直接返回，不再产出业务事件

---

## 7. 提案流式拦截

### 7.0 状态计数按**码点**而非 UTF-16 码元

Python 的字符串索引单位是码点（code point）。若实现时用 JavaScript 的 UTF-16 码元计数，
含 emoji 的文件内容会把增量切在代理对中间，产出半个代理对（渲染成替换字符 `\ufffd`），
且分片边界与 Python 不一致。

实现见 `src/main/agent/loop/proposalStreamer.ts`：所有长度比较与切片都经
`Array.from(str)`（码点数组）完成。

### 7.1 目标

仅拦截两个工具：

| 工具 | 拦截的参数 |
|---|---|
| `write_workspace_file` | `relative_path`、`content` |
| `str_replace_workspace_file` | `relative_path`、`old_string`、`new_string` |

其它工具的分片仍会被累积进状态，但不产生事件。

### 7.2 状态

每条 tool_call 一份状态，键为**该轮内的 tool_call 索引**：

```
{
  args_buf, title_sent, kind ("write" | "edit"),
  content_sent_len, old_sent_len, new_sent_len,
  rel_path, call_id, suppressed
}
```

**必须每轮新建拦截器实例**，因为索引每轮从 0 重新编号。

重置条件：同一索引上 `id` 变化，或 `kind` 变化 → 重建状态。

### 7.3 args 合并（兼容两类 provider）

```
若 chunk_args 以 buf 开头  → 覆盖（累积式或首片）
若 buf 以 chunk_args 开头  → 忽略（重复投递）
否则                      → 拼接（增量式）
```

### 7.4 半截 JSON 解析

解析单键字符串值的算法：

1. 在 buffer 中查找 `"<key>"`，定位其后的第一个 `"`
2. 逐字符解码，转义表：`\n` `\t` `\r` `\\` `\"`；未知转义原样取下一字符
3. 遇到未转义的 `"` → 返回 `(完整值, closed=true)`
4. 到达 buffer 末尾仍未闭合 → 返回 `(已累积部分, closed=false)`
5. key 未出现 → 返回 `(null, false)`

**`\uXXXX` 转义处理**：

- 不足 4 位十六进制 → 暂停解析，等更多分片
- 含非十六进制字符 → 按字面 `u` 输出，避免卡死
- **代理对**：高位 `0xD800-0xDBFF` 且后随 `\uDC00-\uDFFF` → 合成
  `0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)`，消耗 11 字符
- 孤立代理 → `\ufffd`

### 7.5 事件发射时机

每个 chunk 的每条 tool_call 分片：

1. 合并 args 后，若 `args_buf` 非空且尚未发过 start：
   - 解析 `relative_path`，**仅在字符串闭合时**才继续
   - 若路径属于 `.lr-agent` → 标记 `suppressed`，本调用后续不再出事件
   - 否则归一化显示路径，发**一条** `file_proposal_start`（`detail="0"`），标记 `title_sent`
2. `suppressed` → 跳过
3. `kind === "edit"` → 走 `file_edit_delta` 分支
4. `kind === "write"` → 解析 `content`，只要有新增长度就发**一条** `file_proposal_delta`，
   并推进已发送长度

### 7.6 与定稿的对接

拦截器暴露 `streamed_paths_by_call_id()`：返回已出卡且未被 suppress 的
`call_id → 归一化显示路径` 映射。

定稿阶段用它：

- 跳过已流式发出的路径的 `file_proposal_start` / `file_proposal_delta`
- 工具失败时用该映射补发 `status="dismissed"` 的 `file_proposal`

**路径归一化必须单点**：拦截器与定稿必须产出**完全相同的路径字符串**，否则前端会裂成两张卡。
归一化的根顺序为**项目目录优先，其次工作区根**。

---

## 8. 子代理 `explore_readonly`

### 8.1 工具集

```
BASE = { grep_workspace, glob_workspace, list_workspace_directory,
         read_workspace_file, read_document_file,
         describe_client_context, get_lr_agent_help }
ANNOTATION = { read_file_annotation, describe_annotation_project }
FORBIDDEN = { explore_readonly, auto_annotate, mutate_annotation,
              write_workspace_file, str_replace_workspace_file,
              delete_workspace_file, memory_write, memory_create,
              read_image_for_vision }

inner_tools = (BASE ∪ (ANNOTATION if include_annotation)) − FORBIDDEN
              ∩ 父级工具集
```

`include_annotation` 判定：`work_mode === "editor"` → false；无父工具集 → true；否则取决于父
工具集是否含标注只读工具。

### 8.2 行为

- 每轮 `bind_tools(inner_tools)` 后 astream，只取文本转 `subagent_text_delta`
- **不走父级的去重与门禁**，只有白名单校验：不在 `inner_fn_map` 或命中 FORBIDDEN → `blocked`
- blocked 与 allowed 都先追加同一条 assistant 消息，确保每个 tool_call 都有配对的 ToolMessage
- blocked → 发 `subagent_tool_start` + `subagent_tool_result(status="error")`
- allowed → 执行后发 `subagent_tool_result`，结果截断到 4000 字符，**追加原文**（不是显示文本）
- 无 tool call → 该轮文本作为 summary，退出循环
- 轮次耗尽且已有工具调用、summary 仍空 → 追加一条「请用中文给出查阅摘要，不要再调用工具。」
  的 `HumanMessage`，用**不带工具**的调用跑一轮，文本同时作为 `subagent_text_delta` 流出
- 兜底 summary：`status==="error"` → `"查阅失败"`；否则 `"未找到可用结论。"`

### 8.3 Prompt

System 消息固定为：

```
你是只读查阅子代理。只用只读工具查看代码、文档或已有标注，然后用简洁中文写一份摘要。
禁止改文件、写标注、调用 explore_readonly，也禁止声称已经改过文件或完成标注。
调用工具前先用一两句中文说明正在查什么。
查到足够信息后直接给出结论，不要输出工具伪代码。
```

User 消息：`查阅任务：{query}`，若 `focus_path` 非空则追加 `\n优先关注路径：{focus}`。

---

## 9. System prompt 组装

### 9.1 分块顺序（固定，不可调整）

```
1. 身份块（【你的身份】）
2. task 段
3. editor_note（仅编辑器模式）
4. 【项目指令】（若有 project_instructions）
5. 【可用 Skills】（若有 skills_catalog，稳定块）
6. 【工作区记忆】（若 workspace_memory_enabled，动态块）
7. 提案台账（若有 proposal_ledger，动态块）
8. 【任务阶段】（若有阶段，追加在末尾）
```

**顺序设计意图**：稳定块在前、动态块沉底，使 system prompt 的长前缀跨轮保持一致，
以命中 DeepSeek / OpenAI 等服务端的前缀缓存。顺序变化会直接造成缓存失效。

### 9.2 task 段选择优先级

```
work_mode === "editor"                     → 工作区助手（task + 文件编辑纪律 + 工作区信息）
否则 annotation_project_snapshot 非空      → 项目助手（ASSISTANT_TASK_BASE + 项目快照）
      且 agent_mode === "annotation"       → 额外追加标注调用纪律
否则 workspace_root 非空                   → 工作区助手
否则                                       → 裸 WORKSPACE_ASSIST_TASK
```

### 9.3 身份块

```
【你的身份】
- 你是后端模型 `{model}`（配置名称：{provider_label}）。
- {视觉能力行}
- 你在 LR-Agent 系统内与用户对话、调用工具完成任务；不要把自己说成独立的「LR-Agent 助手」或其它品牌模型。
```

视觉能力行二选一：

- `supports_vision` 为真：`视觉能力：已通过 API 探针，可调用 read_image_for_vision 并在调用后查看附图。`
- 否则：`视觉能力：未通过探针或未检测。不要声称能分析图片像素；若用户要看图，说明需在「大模型配置」中选用支持视觉的模型并重新检测视觉。`

`provider_label` 在本地路径**硬编码为 `"local"`**。

### 9.4 项目快照格式

纯文本行，顺序固定：

```
项目 ID: <project_id>
项目名称: <name>
模态: <modality>
标注类型: <annotation_type>
标签列表:
- <id>: <name>            # 最多 40 条；空则 "- （无）"
可用检测模型（object_detection）:   # 仅当标注类型 ∈ {bbox, polygon, keypoint, rotated_bbox}
- <id>: <name> (默认)      # 最多 12 条；空则 "- （未配置或未传入）"
【标注工具】paths 填 list_workspace_directory 的 relativePath；全部文件才设 all_files=true。  # 仅当类型已知
```

特殊标注类型的额外提示：

- `polygon` → 「需配置检测模型与 SAM2 分割模型。」
- `keypoint` → 「需先选择骨架模板并配置关键点模型。」
- `rotated_bbox` → 「需配置 OBB 检测模型。」

### 9.5 硬编码文本清单

以下文本是**行为契约主体，必须原样保留**：

- `VISION_HINT`
- `WORKSPACE_ASSIST_TASK`
- `ASSISTANT_TASK_BASE`
- `FILE_EDIT_GUIDE`
- `ANNOTATION_CALL_GUIDE`
- 标注范围提示与 13 种已知标注类型表
- 身份块模板、记忆使用纪律模板、skills 使用说明模板

> 原文以 `vendor/local-agent/app/agent/context_snapshot.py` 为准（迁移期间）。
> 迁移完成后原文以 `src/main/agent/context/systemPrompt.ts` 为准。

---

## 10. 多模态与视觉

### 10.1 图片加载优先级

1. `image_absolute_path`：`is_file()` 为真则直接 `read_bytes()`（**默认路径，不走 HTTP**）
2. `image_base64`：自动剥离 `data:...,` 前缀
3. 都没有 → 放弃，退化为纯文本消息

### 10.2 缩放与编码

- 非 RGB 处理：RGBA / LA / P 用**白色背景**合成；其余 `convert("RGB")`
- 缩放：`scale = min(1.0, max_edge / max(w, h))`，仅在 `scale < 1` 时缩放，等比
- 编码：JPEG，指定 quality，`optimize=true`
- 输出：`data:image/jpeg;base64,<b64>`

| 配置 | 默认 |
|---|---|
| 附图最长边 | 1280 |
| 附图 JPEG 质量 | 85 |
| 逐框裁剪（视觉映射）最长边 | 768 |
| 逐框裁剪 JPEG 质量 | 85 |

### 10.3 视觉工具与附图注入

`read_image_for_vision` 返回的 JSON 含内部标记 `__vision_image_path__`。调度层：

1. 从结果中提取绝对路径
2. 剥离内部标记后作为 `tool_result` 发给前端
3. **在对应 `ToolMessage` 之后**追加一条多模态 `HumanMessage`，文本固定为
   `【附图】请根据上图回答用户关于该图片的问题。`，并带缩放后的 image_url

### 10.4 视觉自动兜底

触发条件（须全部满足）：

- `round_idx === 0`
- 非 resume
- 本轮无 tool call
- `provider_is_vision` 为真，且视觉工具函数存在
- 用户文本或 `active_relative_path` 能解析出图片路径（后缀 ∈
  `{.png,.jpg,.jpeg,.gif,.webp,.bmp,.ico}`）
- 本次会话尚未兜底过

执行：发 `tool_start` → 执行视觉工具 → 发 `tool_result` → append `ToolMessage` →
若非视觉模型则不再附图。执行后置标记，`continue` 进入下一轮。

---

## 11. 配置默认值

| 配置 | 默认值 |
|---|---|
| 主循环最大工具轮次 | 30 |
| 子代理最大工具轮次 | 12 |
| MCP 工具发现 TTL | 1800 秒 |
| 附图最长边 | 1280 |
| 附图 JPEG 质量 | 85 |
| 单文件读取上限 | 524288 字节（512KB） |
| 单文件读取行数上限 | 2000 |
| 文档提取页数上限 | 30 |
| grep 结果上限 | 100 |
| grep 扫描文件上限 | 1000 |
| 列目录条目上限 | 80 |
| 标注 LLM 温度 | 0.0 |
| 标注准备温度 | 0.1 |
| 生成类标注图片最长边 | 1280 |
| 生成类标注图片 JPEG 质量 | 85 |
| 视觉映射并发度 | 3 |
| 视觉映射是否校验 | true |
| 视觉映射重试次数 | 1 |
| 标签池预检模式 | `"auto"` |
| 标签池预检最小额外标签数 | 2 |
| 标注变更功能开关 | true |

**代码里硬编码、未走配置的编排参数**（不要漏）：

| 参数 | 值 |
|---|---|
| 主 / 辅助模型 `temperature` | 0.7 |
| 主 / 辅助模型 `timeout` | 120 秒 |
| `streaming` | true |
| 质量报告 compose `temperature` | 0.2 |
| 质量报告 payload 上限 | 512KB |
| 质量报告 payload 截断阈值 | 48k 字符 |
| 质量报告图表路径上限 | 50 条 findings |

---

## 12. 持久化边界

**运行时零持久化。** 会话、消息、provider 配置、checkpoint、工作区记忆、标注文档、
质量报告全部在 Electron 主进程（SQLite + 文件系统）。运行时是**无状态**的：每轮从请求体
重建全部上下文。

历史消息流向：

```
SQLite → 渲染层内存 → 请求体（窗口内消息全量序列化）→ 运行时每轮从零重建
```

因此**不存在双写与同步问题**，也没有数据迁移负担。

---

## 13. 已知不一致（迁移时统一）

| 项 | 现状 | 处置 |
|---|---|---|
| Skill 脚本可执行性 | 运行时 prompt 声明「仅可阅读源码，不可执行」，但本地 MCP Server 已暴露 `run_agent_skill_script` | 统一为一种口径并在 prompt 中如实说明 |
| `pypdf` / `python-docx` | 被惰性 import 但**未写入 `requirements.txt`**，干净环境会 ImportError | 迁移时随 `read_document_file` 一并修正 |
| `context_updated` / `route_decided` | 类型已声明但无任何发射点 | 迁移时保留类型以免破坏前端，但不实现发射 |
| 事件字段双份兼容 | 渲染层存在 4 处 snake_case / camelCase 双字段 fallback（说明协议历史上漂移过） | 迁移后固化 `to_sse_dict` 那一版 camelCase 契约，删除 fallback |

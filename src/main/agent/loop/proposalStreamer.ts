/**
 * 写文件 / 局部替换工具的 tool_call_chunks 流式拦截器。
 *
 * 移植自 `vendor/local-agent/app/agent/assist/proposal_streamer.py`。
 *
 * 在 LLM astream 过程中，按 tc_index 递增解析 JSON 参数，实时发射提案 SSE 事件：
 *   - `write_workspace_file` → `file_proposal_start` + `file_proposal_delta`（content 增量）
 *   - `str_replace_workspace_file` → `file_proposal_start(mode=edit)` + `file_edit_delta`
 *     （old_string / new_string 增量，前端据此渲染变更区域的局部 diff）
 *
 * 三个必须保真的要点：
 *
 *   1. **每轮新建实例**。tc_index 每个推理轮次都从 0 重新编号，拦截器实例不能跨轮
 *      复用。作为兜底，`onChunk` 会依据 tool_call id 检测同一 tc_idx 上的新调用并
 *      自动重置状态，防止上一轮的 rel_path / contentSentLen 残留导致 delta 错标路径、
 *      丢失新内容前缀。
 *
 *   2. **按码点（code point）而非 UTF-16 码元计数**。Python 的字符串索引是按码点的，
 *      若按码元计数，含 emoji 的文件内容会把增量切在代理对中间——既与 Python 的
 *      分片边界不一致，也可能产出半个代理对。
 *
 *   3. **路径归一化单点**。模型可能给出绝对路径 / `./` 前缀 / 反斜杠；拦截器与
 *      工具定稿必须产出**同一条**显示路径，否则前端按路径匹配提案块时会裂成两张卡片。
 */

import { sse, type StreamEventPayload } from '../sse';
import {
  isLrAgentRelative,
  normalizeWriteDisplayPath,
  type ClientContextLike,
} from '../tools/workspacePath';

export const WRITE_TOOL_NAME = 'write_workspace_file';
export const EDIT_TOOL_NAME = 'str_replace_workspace_file';

const HEX_DIGITS = /^[0-9a-fA-F]{4}$/;

/** 一个 tool_call 的拦截状态。 */
interface ProposalState {
  argsBuf: string;
  titleSent: boolean;
  kind: 'write' | 'edit';
  /** 已发送的内容长度（**码点**数）。 */
  contentSentLen: number;
  /** 已发送的 old_string 长度（码点数）。 */
  oldSentLen: number;
  /** 已发送的 new_string 长度（码点数）。 */
  newSentLen: number;
  relPath: string;
  callId: string;
  /** 路径落入 `.lr-agent`：本调用后续不再出事件。 */
  suppressed?: boolean;
}

function newState(callId = '', kind: 'write' | 'edit' = 'write'): ProposalState {
  return {
    argsBuf: '',
    titleSent: false,
    kind,
    contentSentLen: 0,
    oldSentLen: 0,
    newSentLen: 0,
    relPath: '',
    callId,
  };
}

/** 码点数组（等价于 Python 的字符串索引单位）。 */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * 解码以 `chars[uPos]`（`'u'` 字符）开头的 `\uXXXX` 转义。
 *
 * @returns `{ text, consumed }`；`text` 为 null 表示序列不完整，调用方应暂停解析、
 *          等待更多分片后整体重解析。支持代理对。
 */
function decodeUnicodeEscape(
  chars: string[],
  uPos: number,
): { text: string | null; consumed: number } {
  const hexPart = chars.slice(uPos + 1, uPos + 5).join('');
  if (hexPart.length < 4) return { text: null, consumed: 0 };
  if (!HEX_DIGITS.test(hexPart)) {
    // 非法转义：按字面输出并跳过，避免解析卡死
    return { text: 'u', consumed: 1 };
  }
  const cp = parseInt(hexPart, 16);

  if (cp >= 0xd800 && cp <= 0xdbff) {
    // 高代理：尝试合成代理对
    const lowEsc = chars.slice(uPos + 5, uPos + 7).join('');
    const lowHex = chars.slice(uPos + 7, uPos + 11).join('');
    if (lowEsc === '\\u' && lowHex.length === 4 && HEX_DIGITS.test(lowHex)) {
      const low = parseInt(lowHex, 16);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const combined = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        return { text: String.fromCodePoint(combined), consumed: 11 };
      }
    }
    return { text: '\ufffd', consumed: 5 };
  }
  if (cp >= 0xdc00 && cp <= 0xdfff) {
    // 孤立低代理
    return { text: '\ufffd', consumed: 5 };
  }
  return { text: String.fromCodePoint(cp), consumed: 5 };
}

/**
 * 从可能不完整的 JSON 缓冲区中提取字符串字段值。
 *
 * 处理标准 JSON 转义（`\n \t \r \\ \" \uXXXX`）。返回：
 *   - key 尚未出现 → `{ value: null, closed: false }`
 *   - 出现但字符串值未闭合引号 → `{ value: 已累积部分, closed: false }`
 *   - 字符串值已闭合引号 → `{ value: 完整值, closed: true }`
 */
export function extractJsonString(
  buf: string,
  key: string,
): { value: string | null; closed: boolean } {
  const chars = codePoints(buf);
  const needle = codePoints(`"${key}"`);

  const idx = indexOfSequence(chars, needle);
  if (idx === -1) return { value: null, closed: false };

  const colon = chars.indexOf(':', idx);
  if (colon === -1) return { value: null, closed: false };

  let quote = -1;
  for (let i = colon + 1; i < chars.length; i += 1) {
    if (chars[i] === '"') {
      quote = i;
      break;
    }
  }
  if (quote === -1) return { value: null, closed: false };

  const result: string[] = [];
  let i = quote + 1;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\\' && i + 1 < chars.length) {
      const nxt = chars[i + 1];
      if (nxt === 'u') {
        const decoded = decodeUnicodeEscape(chars, i + 1);
        if (decoded.text === null) break;
        result.push(decoded.text);
        i += 1 + decoded.consumed;
        continue;
      }
      const escapes: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        '\\': '\\',
        '"': '"',
      };
      result.push(escapes[nxt] ?? nxt);
      i += 2;
    } else if (c === '"') {
      return { value: result.join(''), closed: true };
    } else {
      result.push(c);
      i += 1;
    }
  }
  return { value: result.length ? result.join('') : null, closed: false };
}

/** 在码点数组中查找子序列，返回起始下标；未找到返回 -1。 */
function indexOfSequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 合并参数分片，兼容增量式与累积式两种 provider 行为，重复投递幂等。
 *
 * - `tcArgs` 以 `buf` 开头 → 覆盖（首片或累积式 provider）
 * - `buf` 以 `tcArgs` 开头 → 忽略（已见前缀的重复投递）
 * - 否则 → 拼接（增量式）
 */
function mergeArgs(state: ProposalState, tcArgs: string): void {
  if (!tcArgs) return;
  const buf = state.argsBuf;
  if (tcArgs.startsWith(buf)) {
    state.argsBuf = tcArgs;
  } else if (buf.startsWith(tcArgs)) {
    return;
  } else {
    state.argsBuf = buf + tcArgs;
  }
}

/** 单个 tool_call 分片（与 `LlmDelta.toolCallChunks` 元素同形）。 */
export interface ToolCallChunkInput {
  index: number;
  id?: string;
  name?: string;
  argsFragment?: string;
}

export class ProposalStreamInterceptor {
  private readonly clientContext: ClientContextLike | null;

  private readonly states = new Map<number, ProposalState>();

  constructor(clientContext: ClientContextLike | null = null) {
    // client_context 用于把模型给的 relative_path 归一为与工具定稿事件一致的
    // 显示路径（绝对路径 / ./ 前缀 / 反斜杠都会被归一）
    this.clientContext = clientContext;
  }

  /** 处理一批 tool_call 分片，返回需要产出的 SSE 事件。 */
  onChunk(chunks: ToolCallChunkInput[]): StreamEventPayload[] {
    const events: StreamEventPayload[] = [];

    for (const tc of chunks) {
      const tcName = tc.name;
      const tcArgs = tc.argsFragment ?? '';
      const tcIdx = tc.index;

      if (tcIdx == null) continue;

      if (tcName === WRITE_TOOL_NAME || tcName === EDIT_TOOL_NAME) {
        const tcId = tc.id ?? '';
        const kind: 'write' | 'edit' =
          tcName === EDIT_TOOL_NAME ? 'edit' : 'write';

        let state = this.states.get(tcIdx);
        if (state === undefined) {
          state = newState(tcId, kind);
          this.states.set(tcIdx, state);
        } else if (tcId && state.callId && tcId !== state.callId) {
          // 同一 tc_idx 上出现了新的 tool_call：重置状态。否则上一轮的 rel_path
          // 会错标本轮 delta 的归属路径，contentSentLen 会吞掉新内容的前缀。
          state = newState(tcId, kind);
          this.states.set(tcIdx, state);
        } else if (state.kind !== kind) {
          state = newState(tcId, kind);
          this.states.set(tcIdx, state);
        }
        mergeArgs(state, tcArgs);
      } else {
        const existing = this.states.get(tcIdx);
        if (existing && tcArgs) mergeArgs(existing, tcArgs);
      }

      const current = this.states.get(tcIdx);
      if (!current || !current.argsBuf) continue;
      const state = current;

      if (!state.titleSent) {
        const { value: relPath, closed: relClosed } = extractJsonString(
          state.argsBuf,
          'relative_path',
        );
        if (relPath && relClosed) {
          state.titleSent = true;
          if (isLrAgentRelative(relPath)) {
            state.suppressed = true;
          } else {
            state.relPath = normalizeWriteDisplayPath(this.clientContext, relPath);
            events.push(
              sse.fileProposalStart({
                summary: state.relPath,
                relativePath: state.relPath,
                detail: '0',
                mode: state.kind === 'edit' ? 'edit' : null,
              }),
            );
          }
        }
      }

      if (state.suppressed) continue;

      if (state.kind === 'edit') {
        events.push(...this.editDeltaEvents(state));
        continue;
      }

      const { value: content } = extractJsonString(state.argsBuf, 'content');
      if (content !== null) {
        const contentLen = codePoints(content).length;
        if (contentLen > state.contentSentLen) {
          const delta = codePoints(content)
            .slice(state.contentSentLen)
            .join('');
          state.contentSentLen = contentLen;
          if (delta) {
            events.push(
              sse.fileProposalDelta({
                content: delta,
                relativePath: state.relPath,
              }),
            );
          }
        }
      }
    }

    return events;
  }

  /** 提取 old_string / new_string 增量，合并为一个 `file_edit_delta` 事件。 */
  private editDeltaEvents(state: ProposalState): StreamEventPayload[] {
    const buf = state.argsBuf;
    let oldDelta: string | null = null;
    let newDelta: string | null = null;

    const oldVal = extractJsonString(buf, 'old_string').value;
    if (oldVal !== null) {
      const len = codePoints(oldVal).length;
      if (len > state.oldSentLen) {
        oldDelta = codePoints(oldVal).slice(state.oldSentLen).join('');
        state.oldSentLen = len;
      }
    }
    const newVal = extractJsonString(buf, 'new_string').value;
    if (newVal !== null) {
      const len = codePoints(newVal).length;
      if (len > state.newSentLen) {
        newDelta = codePoints(newVal).slice(state.newSentLen).join('');
        state.newSentLen = len;
      }
    }

    if (!oldDelta && !newDelta) return [];
    return [
      sse.fileEditDelta({
        relativePath: state.relPath,
        oldDelta,
        newDelta,
      }),
    ];
  }

  /**
   * `callId` → 已流式过 start 的显示路径（已归一化）。
   *
   * 定稿时用它抑制重复的 start / delta；工具报错时据此对已出卡的路径补发
   * `dismissed` 终态，避免卡片悬挂。无 call_id 的状态无法关联回具体调用，不进入映射。
   */
  streamedPathsByCallId(): Map<string, string> {
    const streamed = new Map<string, string>();
    for (const state of this.states.values()) {
      const { value: relPath, closed: relClosed } = extractJsonString(
        state.argsBuf,
        'relative_path',
      );
      if (relPath && relClosed && state.titleSent && !state.suppressed) {
        const callId = state.callId || '';
        streamed.set(
          callId,
          state.relPath || normalizeWriteDisplayPath(this.clientContext, relPath),
        );
      }
    }
    return streamed;
  }

  /** 已发送过 `file_proposal_start` 的显示路径集合。 */
  collectedPaths(): Set<string> {
    return new Set(this.streamedPathsByCallId().values());
  }
}

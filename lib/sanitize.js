/**
 * sanitize.js — llm/stream chunk sanitizer.
 *
 * 根因（见 README）：模型/provider 偶发产出退化的 tool-call 块：
 *   { type: 'tool-call', id: '', name: '', arguments: '{}' }
 * 空 id 会让 v4 会话格式在落盘 tool/result 时抛
 *   `format v4 tool/result at seq N requires toolCallId matching its tool source`
 * （写入被拒 → 回合中断 → 会话尾部留下未闭合的 tool/call，崩溃恢复再用空
 *   callId 合成 closer 仍失败 → 该会话永久无法继续）；空 name 会让下一轮请求
 * 被 provider 以 `missing a function name` 400 拒绝。
 *
 * 本模块在 `llm/stream` waterfall 内对 chunk 做最小修补（只改字段，不增删块，
 * 不改变 chunk 顺序与结构，因此对 llm-invariant 的流校验与 BlockAssembler 的
 * 块顺序完全透明）：
 *   - tool-call-delta.id 为空   → 补合成 id（同 index 全程一致）
 *   - block-end 的 tool-call 块：
 *       id 为空   → 补合成 id（优先复用该 index 已见过的真实 id）
 *       name 为空 → 优先复用 delta 中的真实 name，否则换占位名，
 *                   使 dispatch 走 unknown-tool 错误结果路径：错误结果带合法
 *                   callId，可正常落盘、对话继续；历史回放也不再触发 400。
 */
import { randomBytes } from 'node:crypto'

/** 空/缺失 name 时使用的占位工具名（不会命中任何已注册工具 → 走 unknown-tool 错误路径）。 */
export const DEFAULT_PLACEHOLDER_NAME = 'invalid_tool_call'

/** 生成与 provider 风格一致的合成 call id：call_ + 24 位十六进制。 */
export function generateCallId() {
  return `call_${randomBytes(12).toString('hex')}`
}

const isBlank = (value) => typeof value !== 'string' || value.trim().length === 0

/**
 * 一次流内共享的修补状态：记录每个 block index 已见到的真实 id/name，
 * 保证同一块的 delta 与 block-end 最终一致。
 */
export function createBlockState() {
  const ids = new Map()
  const names = new Map()
  return {
    /** 返回该 index 当前采用的 id（不存在则生成并登记）。 */
    idFor(index) {
      let id = ids.get(index)
      if (id === undefined) {
        id = generateCallId()
        ids.set(index, id)
      }
      return id
    },
    /** 登记 provider 给出的真实字段（只登记非空值，真实值优先于合成值）。 */
    note(index, { id, name } = {}) {
      if (!isBlank(id) && !ids.has(index)) ids.set(index, id)
      if (!isBlank(name) && !names.has(index)) names.set(index, name)
    },
    /** 返回该 index 已登记的真实 name（可能 undefined）。 */
    nameFor(index) {
      return names.get(index)
    },
  }
}

/**
 * 修补单个 chunk（纯函数：从不原地修改，未变更时返回原对象引用）。
 * @param chunk - llm/stream 的原始 chunk。
 * @param state - createBlockState() 返回的流内状态。
 * @param placeholderName - 空 name 的占位工具名。
 * @param onRepair - 修补事件回调（用于日志）。
 * @returns 修补后的 chunk（或原 chunk）。
 */
export function repairChunk(chunk, state, placeholderName, onRepair) {
  if (chunk === null || typeof chunk !== 'object') return chunk

  if (chunk.type === 'tool-call-delta') {
    state.note(chunk.index, { id: chunk.id, name: chunk.name })
    if (!isBlank(chunk.id)) return chunk
    const id = state.idFor(chunk.index)
    onRepair?.({ where: 'tool-call-delta', index: chunk.index, id })
    return { ...chunk, id }
  }

  if (chunk.type === 'block-end') {
    const block = chunk.block
    if (!block || typeof block !== 'object' || block.type !== 'tool-call') return chunk
    // block-end 是权威值：先登记它自己的非空字段，再判断是否需要修补。
    state.note(chunk.index, { id: block.id, name: block.name })
    const idMissing = isBlank(block.id)
    const nameMissing = isBlank(block.name)
    if (!idMissing && !nameMissing) return chunk
    const id = idMissing ? state.idFor(chunk.index) : block.id
    // name：block-end 自己 → delta 里登记过的真实 name → 占位名。
    const name = nameMissing ? (state.nameFor(chunk.index) ?? placeholderName) : block.name
    onRepair?.({ where: 'block-end', index: chunk.index, id, name, placeholder: isBlank(block.name) && state.nameFor(chunk.index) === undefined })
    return { ...chunk, block: { ...block, id, name } }
  }

  return chunk
}

/**
 * 创建一次模型调用专用的流清洗器（每次 llm/stream 调用新建，状态不跨流共享）。
 * @param options - { placeholderName, onRepair }。
 * @returns (source: AsyncIterable) => AsyncGenerator 清洗后的 chunk 流。
 */
export function createStreamSanitizer({ placeholderName = DEFAULT_PLACEHOLDER_NAME, onRepair } = {}) {
  const state = createBlockState()
  return async function* sanitize(source) {
    // next() 在个别 waterfall 实现里可能返回 Promise<AsyncIterable>，await 一并兼容。
    const stream = await source
    for await (const chunk of stream) {
      yield repairChunk(chunk, state, placeholderName, onRepair)
    }
  }
}

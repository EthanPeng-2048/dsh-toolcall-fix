/**
 * dsh-plugin-toolcall-fix — Host half.
 *
 * 根因：模型/provider 偶发产出退化的 tool-call 块（id 与 name 均为空串）。
 *   * 空 id → v4 会话格式在落盘 tool/result 时被 assertV4ToolResultMessage 拒绝
 *     （`format v4 tool/result at seq N requires toolCallId matching its tool source`），
 *     写入失败 → 回合中断 → 会话尾部留下未闭合的 tool/call，崩溃恢复再次用空
 *     callId 合成 closer 也失败 → 该会话永久无法继续。
 *   * 空 name → 下一轮请求回放历史时 provider 以
 *     `messages[N].tool_calls[i] is missing a function name` 400 拒绝 → 回合失败。
 *
 * 本插件在公开的 `llm/stream` waterfall 内对 chunk 做最小字段修补（见 lib/sanitize.js）：
 * 只补空 id、换掉空 name，不增删块、不改顺序，因此对 llm-invariant 流校验与
 * BlockAssembler 的块顺序完全透明。空 name 换占位名后 dispatch 走 unknown-tool
 * 错误结果路径：错误结果带合法 callId，可正常落盘，模型看到错误后可自行重试，
 * 对话不再因畸形工具调用而中断。
 *
 * 已落盘的中毒会话请用 `scripts/repair-sessions.mjs` 修复（幂等，先备份）。
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PLACEHOLDER_NAME, createStreamSanitizer } from './sanitize.js'

/** Cordis 插件名（须与 cordis.patch.yml 的 insert id 一致）。 */
export const name = 'toolcall-fix'

/** 无服务依赖：只观察公开的 llm/stream waterfall。 */
export const inject = []

const LOG_PREFIX = '[toolcall-fix]'
/** 保护上限：即便 provider 持续产出畸形流，也不至于刷爆日志。 */
const MAX_REPAIR_LOGS = 200
/** trace 里 llm/stream 事件的上限：足够证明监听器在真实宿主中生效，又不会无限增长。 */
const MAX_STREAM_TRACES = 20
/** debug 打开但未指定 traceFile 时的默认落点。 */
const DEFAULT_TRACE_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'toolcall-fix.trace.jsonl')

/** 读取 loader 下发的配置并做类型收敛（与 dsh-400fix 同风格：自校验，不依赖 schema）。 */
export function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: c.enabled !== false,
    placeholderName:
      typeof c.placeholderName === 'string' && c.placeholderName.trim().length > 0
        ? c.placeholderName.trim()
        : DEFAULT_PLACEHOLDER_NAME,
    debug: c.debug === true,
    traceFile: typeof c.traceFile === 'string' && c.traceFile.length > 0 ? c.traceFile : undefined,
  }
}

/**
 * 安装插件：把清洗器挂到每一次模型调用的 chunk 流上。
 * @param ctx - 插件上下文；监听器随 fiber 一起释放。
 * @param rawConfig - loader 下发的配置（cordis.patch.yml 的 config 字段）。
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger ?? console
  const log = (level, message) => {
    try {
      if (typeof logger[level] === 'function') logger[level](`${LOG_PREFIX} ${message}`)
      else if (typeof logger.info === 'function') logger.info(`${LOG_PREFIX} ${message}`)
    } catch {
      /* 日志失败绝不能影响模型请求 */
    }
  }
  /** 可选 JSONL 诊断（debug=true 时启用）：证明 apply/repair 在真实宿主中执行。 */
  const traceFile = config.debug ? (config.traceFile ?? DEFAULT_TRACE_FILE) : undefined
  const trace = (event) => {
    if (traceFile === undefined) return
    try {
      appendFileSync(traceFile, `${JSON.stringify({ time: Date.now(), ...event })}\n`)
    } catch {
      /* 诊断失败绝不能影响模型请求 */
    }
  }
  trace({ event: 'apply', name, enabled: config.enabled, placeholderName: config.placeholderName })

  log('info', `installed (placeholderName=${config.placeholderName}${config.debug ? ', debug' : ''})`)
  if (!config.enabled) {
    log('info', 'disabled by configuration')
    return
  }

  let repairs = 0
  let streamTraces = 0
  ctx.on('llm/stream', (options, next) => {
    if (streamTraces < MAX_STREAM_TRACES) {
      streamTraces++
      trace({ event: 'llm/stream', purpose: options?.purpose ?? null, model: options?.model ?? null })
      if (streamTraces === MAX_STREAM_TRACES) {
        trace({ event: 'llm/stream-trace-suppressed', note: `further llm/stream traces suppressed after ${MAX_STREAM_TRACES}` })
      }
    }
    const onRepair = (event) => {
      repairs++
      if (repairs > MAX_REPAIR_LOGS) return
      trace({ event: 'repair', where: event.where, index: event.index, id: event.id, name: event.name ?? null })
      const detail = `index=${event.index} id=${JSON.stringify(event.id)}${event.name !== undefined ? ` name=${JSON.stringify(event.name)}` : ''}`
      const tail = repairs === MAX_REPAIR_LOGS ? ` (further repair logs suppressed)` : ''
      const purpose = typeof options?.purpose === 'string' ? ` purpose=${options.purpose}` : ''
      log('warn', `repaired malformed tool-call chunk at ${event.where}: ${detail}${purpose}${tail}`)
    }
    // 每次调用新建清洗器：合成 id 的 per-index 状态绝不跨流共享。
    const sanitize = createStreamSanitizer({ placeholderName: config.placeholderName, onRepair })
    return sanitize(next())
  })
}

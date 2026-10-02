#!/usr/bin/env node
/**
 * repair-sessions.mjs — 修复被空 tool-call id/name 中毒的会话日志。
 *
 * 用法：
 *   node scripts/repair-sessions.mjs            # dry-run：只报告将要做的修改
 *   node scripts/repair-sessions.mjs --write    # 备份 + 改写 + 写后自验
 *   node scripts/repair-sessions.mjs --write --root <sessions目录>
 *
 * 修复语义（对 v3 与 v4 同构，全部是"补字段"，不增删事件、不改 seq）：
 *   1. assistant/message 里 id 或 name 为空的 tool-call 块
 *        id   空 → 合成 call_<24hex>（同一次修复内 call/result 共用）
 *        name 空 → 占位名 invalid_tool_call
 *   2. tool/call 的空 callId → 同一个合成 id；空 name → 与 assistant 块一致
 *   3. tool/result
 *        v3: wrapper.toolCallId 与 source.callId → 同一个合成 id（liftToolResult 迁移前提）
 *        v4: message.toolCallId 与 source.callId → 同一个合成 id
 *      空 name 造成的错误文案 `unknown tool ""` 一并改为占位名，保持历史自洽
 *   4. assistant/message.data.stream 内的 tool-call delta/chunks/block-end 同步补齐
 *      （仅展示/回放用，但保持与 content 一致，避免 UI 显示空 id）
 *
 * 修复后该 v4 会话的恢复链路变为合法：
 *   seq137 广告合成 id → seq138 tool/call 匹配 → 尾部无 result 允许（不完整尾部）
 *   → 崩溃恢复在 seq139 合成 closer 用同一合成 id → 校验通过 → 对话可继续。
 *
 * 写入策略：整文件重编码为单个 zstd 帧（读取方对单帧/多帧都兼容），
 * 先写 .tmp 再覆盖，写完重新解码自验；原文件先备份为 .bak。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'

const DEFAULT_ROOT = 'C:/Users/ethan/.dsh/sessions'
const PLACEHOLDER = 'invalid_tool_call'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const rootIdx = args.indexOf('--root')
const ROOT = rootIdx >= 0 ? args[rootIdx + 1] : DEFAULT_ROOT

const mint = () => `call_${randomBytes(12).toString('hex')}`
const blank = (v) => typeof v !== 'string' || v.trim().length === 0

/** 多帧 zstd → 行数组（按魔数切帧、逐帧解码、跳过伪命中）。 */
function decodeLines(file) {
  const src = fs.readFileSync(file)
  const offsets = []
  for (let i = 0; i <= src.length - 4; i++) {
    if (src[i] === 0x28 && src[i + 1] === 0xb5 && src[i + 2] === 0x2f && src[i + 3] === 0xfd) offsets.push(i)
  }
  const lines = []
  let frames = 0
  for (const off of offsets) {
    try {
      const text = zlib.zstdDecompressSync(src.subarray(off)).toString('utf8')
      frames++
      for (const line of text.split('\n')) if (line) lines.push(line)
    } catch {
      /* 魔数伪命中：跳过 */
    }
  }
  return { lines, frames }
}

/** 会话 id：优先取 header.id，退化为目录名。 */
function sessionIdOf(file, header) {
  if (header && typeof header.id === 'string' && header.id) return header.id
  return path.basename(path.dirname(file))
}

const problems = []

/** 每个 (turn,step) 的工具调用台账。 */
function createLedger() {
  const byStep = new Map()
  const step = (turn, s) => {
    const key = `${turn}:${s}`
    if (!byStep.has(key)) byStep.set(key, [])
    return byStep.get(key)
  }
  return { step }
}

/**
 * 修补一个事件，返回是否修改。
 * @param ev - 已解析的事件对象（原地修改）。
 * @param ledger - 跨事件的 (turn,step) 台账。
 */
function patchEvent(ev, ledger) {
  const data = ev.data
  if (!data || typeof data !== 'object') return false
  let changed = false
  const ts = ledger.step(data.turn, data.step)

  // 优先匹配"本次中毒"的条目：避免同 step 内健康调用与中毒调用串位。
  const nextUnused = () => ts.find((c) => !c.started && c.poisoned) ?? ts.find((c) => !c.started) ?? null
  const nextUnresolved = () => ts.find((c) => c.started && !c.resolved && c.poisoned) ?? ts.find((c) => c.started && !c.resolved) ?? null

  if (ev.type === 'assistant/message') {
    const message = data.message
    const content = message && Array.isArray(message.content) ? message.content : null
    const poisonedIds = []
    if (content) {
      for (const block of content) {
        if (!block || block.type !== 'tool-call') continue
        const wasPoisoned = blank(block.id) || blank(block.name)
        if (blank(block.id)) {
          block.id = mint()
          poisonedIds.push(block.id)
          changed = true
        }
        if (blank(block.name)) {
          block.name = PLACEHOLDER
          changed = true
        }
        // 登记到台账（同一块只登记一次；后续 tool/call/tool/result 都按 id 对齐）
        const existing = ts.find((c) => c.blockRef === block)
        if (existing) {
          existing.id = block.id
          existing.name = block.name
          existing.poisoned ||= wasPoisoned
        } else {
          ts.push({ blockRef: block, id: block.id, name: block.name, poisoned: wasPoisoned, started: false, resolved: false })
        }
      }
    }
    // 同步 data.stream 里的 tool-call 记录（展示/回放用）
    if (poisonedIds.length > 0 && Array.isArray(data.stream)) {
      const single = poisonedIds.length === 1 ? poisonedIds[0] : null
      const seenIndex = new Map()
      for (const chunk of data.stream) {
        if (!chunk || typeof chunk !== 'object') continue
        const inner = chunk.type === 'chunk' && chunk.chunk ? chunk.chunk : chunk
        const isToolCall =
          inner.type === 'tool-call-delta' ||
          inner.type === 'tool-call-chunks' ||
          (inner.type === 'block-end' && inner.block && inner.block.type === 'tool-call')
        if (!isToolCall) continue
        const useId = () => {
          if (seenIndex.has(inner.index)) return seenIndex.get(inner.index)
          const fallback = single ?? null
          if (fallback) seenIndex.set(inner.index, fallback)
          return fallback
        }
        // 顶层 id 只属于 delta/chunks；block-end chunk 的 id 在 block 内。
        if (inner.type !== 'block-end' && blank(inner.id)) {
          const id = useId()
          if (id) {
            inner.id = id
            changed = true
          } else {
            problems.push(`${ev.type}@${ev.seq}: data.stream 内 tool-call id 为空且无法映射（多块歧义），已跳过`)
          }
        }
        if (inner.type === 'tool-call-chunks' && blank(inner.name)) {
          inner.name = PLACEHOLDER
          changed = true
        }
        if (inner.type === 'block-end' && inner.block && blank(inner.block.id)) {
          const id = useId()
          if (id) {
            inner.block.id = id
            changed = true
          }
        }
        if (inner.type === 'block-end' && inner.block && blank(inner.block.name)) {
          inner.block.name = PLACEHOLDER
          changed = true
        }
      }
    }
    return changed
  }

  if (ev.type === 'tool/call') {
    if (blank(data.callId)) {
      const target = nextUnused()
      if (target) {
        data.callId = target.id
        if (blank(data.name)) data.name = target.name
        target.started = true
        changed = true
      } else {
        problems.push(`tool/call@${ev.seq}: callId 为空但台账无对应 assistant 广告（turn=${data.turn} step=${data.step}），无法修复`)
      }
    } else {
      const target = ts.find((c) => c.id === data.callId)
      if (target) target.started = true
      if (blank(data.name)) {
        if (target) {
          data.name = target.name
          changed = true
        }
      }
    }
    return changed
  }

  if (ev.type === 'tool/result') {
    const message = data.message
    if (!message || typeof message !== 'object') return false
    // v3: role=user + wrapper；v4: role=tool
    const wrapper = Array.isArray(message.content) && message.content[0] && message.content[0].type === 'tool-result' ? message.content[0] : null
    const isV3 = message.role === 'user' && wrapper
    const targetIdField = isV3 ? wrapper.toolCallId : message.toolCallId
    const source = message.source && typeof message.source === 'object' ? message.source : null

    if (blank(targetIdField) || (source && blank(source.callId))) {
      const target = nextUnresolved() ?? nextUnused()
      if (!target) {
        problems.push(`tool/result@${ev.seq}: 空 toolCallId 但台账无匹配调用，无法修复`)
        return false
      }
      const id = target.id
      if (isV3) {
        wrapper.toolCallId = id
        if (source) source.callId = id
      } else {
        message.toolCallId = id
        if (source) source.callId = id
      }
      target.resolved = true
      changed = true
      // 错误文案自洽：`unknown tool ""` → `unknown tool "<placeholder>"`
      if (blank(target.name) || target.name === PLACEHOLDER) {
        const blocks = isV3 ? wrapper.content : message.content
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b && typeof b === 'object' && typeof b.text === 'string' && b.text.includes('unknown tool ""')) {
              b.text = b.text.replace('unknown tool ""', `unknown tool "${PLACEHOLDER}"`)
              changed = true
            }
          }
        }
      }
    } else {
      const target = ts.find((c) => c.id === (isV3 ? wrapper.toolCallId : message.toolCallId))
      if (target) target.resolved = true
    }
    return changed
  }

  return false
}

/** 修复后的文件必须通过的自检（与 scan-sessions 同口径的核心子集）。 */
function verify(lines) {
  const errors = []
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    return ['header 不是 JSON']
  }
  if (header.type !== 'session') errors.push('首行不是 session header')
  const events = []
  lines.slice(1).forEach((l, i) => {
    try {
      const o = JSON.parse(l)
      if (o.seq !== i) errors.push(`seq 不稠密：index=${i} seq=${o.seq}`)
      events.push(o)
    } catch {
      errors.push(`第 ${i + 1} 个事件行不是 JSON`)
    }
  })
  const nonempty = (v) => typeof v === 'string' && v.length > 0
  for (const ev of events) {
    if (ev.type === 'assistant/message') {
      for (const b of ev.data?.message?.content ?? []) {
        if (b?.type === 'tool-call' && (!nonempty(b.id) || !nonempty(b.name))) {
          errors.push(`seq ${ev.seq} assistant/tool-call 仍为空 (id=${JSON.stringify(b.id)} name=${JSON.stringify(b.name)})`)
        }
      }
    }
    if (ev.type === 'tool/call' && !nonempty(ev.data?.callId)) errors.push(`seq ${ev.seq} tool/call callId 仍为空`)
    if (ev.type === 'tool/result') {
      const m = ev.data?.message
      const wrapper = Array.isArray(m?.content) && m.content[0]?.type === 'tool-result' ? m.content[0] : null
      const id = wrapper ? wrapper.toolCallId : m?.toolCallId
      const sc = m?.source?.callId
      if (!nonempty(id) || !nonempty(sc) || id !== sc) errors.push(`seq ${ev.seq} tool/result id 不合法 (id=${JSON.stringify(id)} source=${JSON.stringify(sc)})`)
    }
  }
  return errors
}

// ---------- main ----------
const files = []
;(function walk(d) {
  let entries
  try {
    entries = fs.readdirSync(d, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.zstd$/.test(e.name)) files.push(p)
  }
})(ROOT)

console.log(`扫描 ${files.length} 个会话文件（root=${ROOT}，模式=${WRITE ? 'WRITE' : 'dry-run'}）`)

let repaired = 0
for (const file of files.sort()) {
  const { lines } = decodeLines(file)
  if (lines.length === 0) continue
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    continue
  }
  if (header.type !== 'session') continue

  // 结构预检：非稠密/坏行的文件不碰
  let structurallySound = true
  lines.slice(1).forEach((l, i) => {
    try {
      if (JSON.parse(l).seq !== i) structurallySound = false
    } catch {
      structurallySound = false
    }
  })
  if (!structurallySound) {
    console.log(`  跳过（结构异常）: ${path.relative(ROOT, file)}`)
    continue
  }

  const ledger = createLedger()
  let touched = 0
  const outLines = lines.map((l, i) => {
    if (i === 0) return l
    let ev
    try {
      ev = JSON.parse(l)
    } catch {
      return l
    }
    const before = JSON.stringify(ev)
    const changed = patchEvent(ev, ledger)
    if (!changed) return l
    touched++
    return JSON.stringify(ev)
  })

  if (touched === 0) continue
  repaired++
  const sid = sessionIdOf(file, header)
  console.log(`\n${WRITE ? '修复' : '[dry-run] 将修复'} ${path.relative(ROOT, file)}（会话 ${sid}，改写 ${touched} 个事件）`)

  if (!WRITE) continue

  // 备份
  const bak = `${file}.bak`
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak)
  else {
    const stamped = `${file}.bak-${Date.now()}`
    fs.copyFileSync(file, stamped)
    console.log(`  已存在备份，另存为 ${path.basename(stamped)}`)
  }

  // 写临时文件 → 自验 → 覆盖
  const payload = outLines.join('\n') + '\n'
  const compressed = zlib.zstdCompressSync(Buffer.from(payload, 'utf8'))
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, compressed)

  const redecoded = decodeLines(tmp).lines
  const errs = verify(redecoded)
  if (errs.length > 0) {
    fs.unlinkSync(tmp)
    console.log(`  !! 写后自验失败，已放弃改写：\n     ${errs.join('\n     ')}`)
    continue
  }

  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.copyFileSync(tmp, file)
    fs.unlinkSync(tmp)
  }

  // 使投影缓存失效（存在则删除，读取时会重建）
  const cache = `C:/Users/ethan/.dsh/storages/session_projcache/sessions/${sid}.json`
  if (fs.existsSync(cache)) {
    fs.unlinkSync(cache)
    console.log('  已删除过期投影缓存')
  }
  console.log('  写后自验通过 ✓')
}

console.log(`\n${WRITE ? '已修复' : '[dry-run] 待修复'} ${repaired} 个文件`)
if (problems.length > 0) {
  console.log('\n需要注意的问题：')
  for (const p of problems) console.log(`  - ${p}`)
}
process.exit(0)

#!/usr/bin/env node
/**
 * scan-sessions.mjs — 全量扫描 ~/.dsh/sessions 下的会话日志。
 *
 * 检查项（按格式版本）：
 *   v4: seq 稠密性、tool/result 行准入（assertV4ToolResultMessage 等价规则）、
 *       空 tool-call id（assistant 块 / tool/call / tool/result）、
 *       未闭合的尾部 tool 调用（提示崩溃恢复将补合成结果）。
 *   v3: liftToolResult 迁移前提（wrapper 与 source 的 callId 非空且一致）、
 *       空 tool-call id。
 *
 * 退出码：发现 ERROR 级问题 → 1，否则 0。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

const ROOT = process.env.DSH_SESSIONS_ROOT ?? 'C:/Users/ethan/.dsh/sessions'

/** 把多帧 zstd 文件解码为行数组（按魔数切帧，逐帧校验可解码，跳过伪命中）。 */
function decodeLines(file) {
  const src = fs.readFileSync(file)
  const offsets = []
  for (let i = 0; i <= src.length - 4; i++) {
    if (src[i] === 0x28 && src[i + 1] === 0xb5 && src[i + 2] === 0x2f && src[i + 3] === 0xfd) offsets.push(i)
  }
  const lines = []
  for (const off of offsets) {
    try {
      const text = zlib.zstdDecompressSync(src.subarray(off)).toString('utf8')
      for (const line of text.split('\n')) if (line) lines.push(line)
    } catch {
      /* 魔数伪命中：忽略 */
    }
  }
  return lines
}

function nonempty(v) {
  return typeof v === 'string' && v.length > 0
}

/** v4 tool/result 行准入（对齐 assertV4ToolResultMessage）。 */
function checkV4ToolResult(event) {
  const problems = []
  const subject = `format v4 tool/result at seq ${event.seq}`
  const data = event.data
  if (!data || typeof data !== 'object') return [`${subject} data must be an object`]
  const m = data.message
  if (!m || typeof m !== 'object') return [`${subject} message must be an object`]
  if (!nonempty(m.id)) problems.push(`${subject} requires a first-class message with a string id`)
  if (m.role !== 'tool') problems.push(`${subject} requires a tool-role message`)
  const sourceCallId = m.source && typeof m.source === 'object' ? m.source.callId : undefined
  if (!nonempty(m.toolCallId) || sourceCallId !== m.toolCallId) {
    problems.push(`${subject} requires toolCallId matching its tool source`)
  }
  if (!m.source || typeof m.source !== 'object' || m.source.kind !== 'tool') problems.push(`${subject} requires a tool source`)
  if (!Array.isArray(m.content)) problems.push(`${subject} requires array content`)
  else if (m.content.some(b => b && typeof b === 'object' && b.type === 'tool-result')) {
    problems.push(`${subject} content must not contain a released tool-result wrapper`)
  }
  if (m.isError !== undefined && typeof m.isError !== 'boolean') problems.push(`${subject} isError must be boolean when present`)
  if (data.error !== undefined && m.isError !== true) problems.push(`${subject} carries error metadata for a non-error tool result`)
  return problems
}

function scanFile(file) {
  const report = { file, version: '?', errors: [], warnings: [], infos: [] }
  let lines
  try {
    lines = decodeLines(file)
  } catch (e) {
    report.errors.push(`decode failed: ${e.message}`)
    return report
  }
  if (!lines.length) {
    // 0 字节会话文件（创建中断的残留，与本修复无关）：记为警告而非错误。
    report.warnings.push('empty file (0-byte session log, likely an aborted session creation)')
    return report
  }
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    report.errors.push('header line is not JSON')
    return report
  }
  if (header.type !== 'session') {
    report.errors.push('first line is not a session header')
    return report
  }
  report.version = header.version

  const events = []
  for (const line of lines.slice(1)) {
    try {
      events.push(JSON.parse(line))
    } catch {
      report.errors.push(`unparseable event line: ${line.slice(0, 80)}`)
    }
  }

  // seq 稠密性（迁移/追加均要求 event.seq === index）
  events.forEach((e, i) => {
    if (e.seq !== i) report.errors.push(`seq not dense at index ${i}: seq=${e.seq} type=${e.type}`)
  })

  if (report.version === 4) scanV4(events, report)
  else if (report.version === 3) scanV3(events, report)
  else report.warnings.push(`unknown version ${report.version}`)

  return report
}

function scanV4(events, report) {
  const pending = new Map() // callId -> { name, arguments, started, advertisedAt }

  for (const e of events) {
    if (e.type === 'tool/result') {
      report.errors.push(...checkV4ToolResult(e))
      const m = e.data?.message
      // DSH relationships：surfaceOp 非 append 的 tool/result（compaction/prune 的
      // replace 重写）直接跳过生命周期结算，不解析 pending。
      const op = e.surfaceOp
      const isReplace = op !== undefined && op !== null && typeof op === 'object' && op.op === 'replace'
      if (m && typeof m === 'object') {
        if (!nonempty(m.toolCallId)) report.errors.push(`seq ${e.seq} tool/result has empty toolCallId`)
        else if (isReplace) {
          /* replace 重写：原始结果已在早前结算，此处不要求 pending */
        } else if (!pending.has(m.toolCallId)) report.errors.push(`seq ${e.seq} tool/result resolves unknown call ${JSON.stringify(m.toolCallId)}`)
        else {
          const p = pending.get(m.toolCallId)
          if (!p.started) report.errors.push(`seq ${e.seq} tool/result for a call with no tool/call event`)
          pending.delete(m.toolCallId)
        }
      }
      continue
    }
    if (e.type === 'assistant/message') {
      const content = e.data?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool-call') continue
          if (!nonempty(block.id)) {
            report.errors.push(`seq ${e.seq} assistant/tool-call block has EMPTY id (name=${JSON.stringify(block.name)})`)
            continue
          }
          if (pending.has(block.id)) report.errors.push(`seq ${e.seq} repeats advertised tool call ${block.id}`)
          else pending.set(block.id, { name: block.name, arguments: block.arguments, started: false, advertisedAt: e.seq })
        }
      }
      continue
    }
    if (e.type === 'tool/call') {
      const id = e.data?.callId
      if (!nonempty(id)) {
        report.errors.push(`seq ${e.seq} tool/call has EMPTY callId (name=${JSON.stringify(e.data?.name)})`)
        continue
      }
      const p = pending.get(id)
      if (!p) {
        report.errors.push(`seq ${e.seq} tool/call ${id} has no advertised tool lifecycle`)
        continue
      }
      if (p.started) report.errors.push(`seq ${e.seq} tool/call ${id} started twice`)
      if (p.name !== e.data.name || p.arguments !== e.data.arguments) {
        report.errors.push(`seq ${e.seq} tool/call ${id} does not match its advertised block`)
      }
      p.started = true
      continue
    }
    if (e.type === 'step/end' || e.type === 'turn/end') {
      for (const [id, p] of pending) {
        report.errors.push(`${e.type} at seq ${e.seq} leaves unresolved tool call ${id} (advertised seq ${p.advertisedAt})`)
      }
      pending.clear()
    }
  }

  if (pending.size > 0) {
    const ids = [...pending.keys()]
    report.infos.push(`open tail: ${pending.size} unresolved tool call(s) [${ids.map(s => JSON.stringify(s)).join(', ')}] — 崩溃恢复会在下次打开时补合成结果`)
  }
}

function scanV3(events, report) {
  const advertised = []
  for (const e of events) {
    if (e.type === 'assistant/message') {
      const content = e.data?.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool-call') continue
          if (!nonempty(block.id)) report.errors.push(`seq ${e.seq} assistant/tool-call block has EMPTY id (name=${JSON.stringify(block.name)})`)
        }
      }
      continue
    }
    if (e.type === 'tool/call') {
      if (!nonempty(e.data?.callId)) report.errors.push(`seq ${e.seq} tool/call has EMPTY callId (name=${JSON.stringify(e.data?.name)})`)
      continue
    }
    if (e.type === 'tool/result') {
      const m = e.data?.message
      if (!m || typeof m !== 'object') continue
      const w = Array.isArray(m.content) && m.content[0]?.type === 'tool-result' ? m.content[0] : undefined
      if (!w) continue // 已是一等 v3 形态或其他形态，交给迁移器
      const sc = m.source && typeof m.source === 'object' ? m.source.callId : undefined
      if (!nonempty(w.toolCallId) || !nonempty(sc) || w.toolCallId !== sc) {
        report.errors.push(
          `seq ${e.seq} v3 tool/result wrapper mismatch (toolCallId=${JSON.stringify(w.toolCallId)}, source.callId=${JSON.stringify(sc)}) — ` +
          `liftToolResult 迁移会抛 format v3 ... requires exactly one tool-result wrapper matching its tool source`
        )
      }
    }
  }
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

let errorFiles = 0
let warnFiles = 0
for (const f of files.sort()) {
  const r = scanFile(f)
  if (r.errors.length || r.warnings.length) {
    if (r.errors.length) errorFiles++
    else warnFiles++
    console.log(`\n=== ${path.relative(ROOT, f)} (v${r.version})`)
    for (const p of r.errors) console.log(`  ERROR   ${p}`)
    for (const p of r.warnings) console.log(`  WARN    ${p}`)
    for (const p of r.infos) console.log(`  info    ${p}`)
  }
}
console.log(`\nscanned ${files.length} files; ${errorFiles} with errors, ${warnFiles} with warnings only`)
process.exit(errorFiles > 0 ? 1 : 0)

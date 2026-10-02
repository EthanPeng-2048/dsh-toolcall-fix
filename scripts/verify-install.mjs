#!/usr/bin/env node
/**
 * verify-install.mjs — 端到端验证插件在 profile 中可被解析并正确工作。
 *
 * 关键点：以 profile 目录为 cwd 启动子进程，用裸包名 `dsh-plugin-toolcall-fix`
 * 动态 import —— 这正是 cordis loader 解析 bundle 的路径（经 profile/node_modules
 * 的 junction），可同时验证：junction 有效、package.json exports 正确、
 * apply() 接线、以及对"真实中毒 chunk 序列"的修补结果。
 *
 * 用法：node scripts/verify-install.mjs [--profile <dir>]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const pIdx = args.indexOf('--profile')
const PROFILE = pIdx >= 0 ? args[pIdx + 1] : 'C:/Users/ethan/.dsh/profiles/desktop'
const PKG = 'dsh-plugin-toolcall-fix'

if (!fs.existsSync(path.join(PROFILE, 'node_modules', PKG))) {
  console.error(`FAIL: ${PROFILE}/node_modules/${PKG} 不存在（junction 未创建）`)
  process.exit(1)
}

// 子进程内代码：以 profile 为 cwd，裸包名解析 → apply → 真实中毒流 → 断言。
const childCode = `
const m = await import(${JSON.stringify(PKG)})
const handlers = {}
const warnings = []
const ctx = {
  logger: { info() {}, warn(msg) { warnings.push(String(msg)) }, error() {} },
  on(event, handler) { handlers[event] = handler },
}
m.apply(ctx, { placeholderName: 'invalid_tool_call', debug: false })
if (typeof handlers['llm/stream'] !== 'function') throw new Error('llm/stream 未注册')

// session-d724c0f7 seq137 的真实退化流（live wire 格式）
const poison = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 't' },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '{"type":"text","text":' },
  { type: 'block-start', index: 2, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 2, id: '', argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 't' } },
  { type: 'block-end', index: 1, block: { type: 'text', text: '{"type":"text","text":' } },
  { type: 'block-end', index: 2, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } },
  { type: 'usage', usage: { inputTokens: 6163, outputTokens: 3674 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const out = []
for await (const c of handlers['llm/stream']({}, () => poison)) out.push(c)

const checks = {}
checks.entryName = m.name
checks.chunkCountUnchanged = out.length === poison.length
const end = out.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
checks.idRepaired = /^call_[0-9a-f]{24}$/.test(end?.block?.id ?? '')
checks.nameRepaired = end?.block?.name === 'invalid_tool_call'
checks.argsKept = end?.block?.arguments === '{}'
const delta = out.find((c) => c.type === 'tool-call-delta')
checks.deltaMatchesBlock = delta.id === end.block.id
checks.repairLogged = warnings.some((w) => w.includes('repaired malformed tool-call chunk'))
// 健康流零改动
const healthy = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call_7b1eb3423d924f92a0f58949', name: 'pwsh', argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_7b1eb3423d924f92a0f58949', name: 'pwsh', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const hout = []
for await (const c of handlers['llm/stream']({}, () => healthy)) hout.push(c)
checks.healthyUnchanged = hout.every((c, i) => c === healthy[i])
console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }))
`

const res = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
  cwd: PROFILE,
  encoding: 'utf8',
  timeout: 30000,
})

if (res.status !== 0) {
  console.error('FAIL: 子进程执行失败')
  console.error(res.stderr || res.stdout)
  process.exit(1)
}

let report
try {
  const lines = res.stdout.trim().split('\n')
  report = JSON.parse(lines[lines.length - 1])
} catch {
  console.error('FAIL: 无法解析子进程输出：')
  console.error(res.stdout)
  process.exit(1)
}

console.log('裸包名解析与 apply 接线验证：')
for (const [k, v] of Object.entries(report.checks)) {
  console.log(`  ${v ? '✓' : '✗'} ${k}`)
}
if (!report.ok) {
  console.error('\nFAIL')
  process.exit(1)
}
console.log('\nPASS — 插件可通过 profile/node_modules 正确加载并修补真实中毒流')

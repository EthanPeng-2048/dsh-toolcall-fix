/**
 * sanitize 单元测试：用真实中毒日志（session-d724c0f7 seq137、
 * session-aec5e44d seq474 的 provider 400）里的 chunk 形态做 fixture。
 *
 * 关键断言：
 *   1. 空 id → 同一 index 的 delta 与 block-end 得到同一个合成 id；
 *   2. 空 name → 优先复用 delta 真实 name，否则占位名；
 *   3. chunk 结构/顺序/数量不变（BlockAssembler 与 llm-invariant 透明）；
 *   4. 健康 chunk 原样透传（同引用）；
 *   5. 插件 apply 接线：ctx.on('llm/stream') 返回可迭代的已清洗流。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_PLACEHOLDER_NAME,
  createBlockState,
  createStreamSanitizer,
  generateCallId,
  repairChunk,
} from '../lib/sanitize.js'
import { apply, resolveConfig } from '../lib/main.js'

async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** 来自 session-d724c0f7 seq137 的真实退化流（live wire 格式）。 */
function poisonStream() {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking…' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '{"type":"text","text":' },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: '', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking…' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: '{"type":"text","text":' } },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 6163, outputTokens: 3674 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 健康流（真实 pwsh 调用形态）。 */
function healthyStream() {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_7b1eb3423d924f92a0f58949', name: 'pwsh', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_7b1eb3423d924f92a0f58949', name: 'pwsh', arguments: '{"command":"ls"}' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

test('generateCallId 形如 call_+24位hex，且互不相同', () => {
  const a = generateCallId()
  const b = generateCallId()
  assert.match(a, /^call_[0-9a-f]{24}$/)
  assert.notEqual(a, b)
})

test('中毒流：空 id/name 被修补，结构与顺序不变', async () => {
  const src = poisonStream()
  const out = await collect(createStreamSanitizer()(src))

  assert.equal(out.length, src.length, 'chunk 数量必须不变')
  // 非 tool-call 块与 block-start 完全不动（同引用）
  for (const i of [0, 1, 2, 3, 4, 9, 10]) assert.equal(out[i], src[i], `chunk ${i} 应保持原引用`)

  const delta = out[5]
  assert.match(delta.id, /^call_[0-9a-f]{24}$/, 'delta id 必须被补成合成 id')

  const end = out[8].block
  assert.equal(end.id, delta.id, 'block-end 与 delta 必须使用同一个合成 id')
  assert.equal(end.name, DEFAULT_PLACEHOLDER_NAME, '空 name 必须换成占位名')
  assert.equal(end.arguments, '{}', 'arguments 原样保留')
  assert.equal(end.type, 'tool-call')

  assert.deepEqual(out.map((c) => c.type), src.map((c) => c.type))
})

test('block-end name 为空但 delta 带真实 name → 复用 delta 的 name', async () => {
  const src = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_aaaaaaaa00000000000000aa', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_aaaaaaaa00000000000000aa', name: '', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await collect(createStreamSanitizer()(src))
  assert.equal(out[1], src[1], '健康 delta 原引用')
  assert.equal(out[2].block.name, 'read', '应复用 delta 中的真实 name 而非占位名')
  assert.equal(out[2].block.id, 'call_aaaaaaaa00000000000000aa')
})

test('同一 index 的多个 delta 共享同一个合成 id', async () => {
  const src = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{"a"' },
    { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: ':1}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read', arguments: '{"a":1}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await collect(createStreamSanitizer()(src))
  assert.match(out[1].id, /^call_/)
  assert.equal(out[1].id, out[2].id)
  assert.equal(out[1].id, out[3].block.id)
  assert.equal(out[3].block.name, 'read', '健康 name 不动')
})

test('id 缺失(undefined)同样被补上', async () => {
  const src = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: undefined, name: 'grep', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await collect(createStreamSanitizer()(src))
  assert.match(out[1].id, /^call_[0-9a-f]{24}$/)
  assert.equal(out[1].id, out[2].block.id)
  assert.equal(out[2].block.name, 'grep')
})

test('provider 给了真实 id 但 block-end 为空时，复用 provider 的 id', async () => {
  const src = [
    { type: 'block-start', index: 7, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 7, id: 'call_feedface00000000000000aa', argumentsDelta: '{}' },
    { type: 'block-end', index: 7, block: { type: 'tool-call', id: '', name: 'x', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await collect(createStreamSanitizer()(src))
  assert.equal(out[1], src[1], '健康 delta 保持原引用')
  assert.equal(out[2].block.id, 'call_feedface00000000000000aa', 'block-end 应复用 delta 里 provider 的真实 id')
  assert.equal(out[2].block.name, 'x')
})

test('不同 index 得到不同合成 id', async () => {
  const src = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: '' },
    { type: 'tool-call-delta', index: 1, id: '' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'a', arguments: '{}' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: 'b', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const out = await collect(createStreamSanitizer()(src))
  assert.notEqual(out[2].id, out[3].id)
  assert.equal(out[4].block.id, out[2].id)
  assert.equal(out[5].block.id, out[3].id)
})

test('健康流完全同引用透传（零开销）', async () => {
  const src = healthyStream()
  const out = await collect(createStreamSanitizer()(src))
  assert.deepEqual(out, src)
  for (let i = 0; i < src.length; i++) assert.equal(out[i], src[i], `chunk ${i} 必须保持原引用`)
})

test('非 tool-call 的 block-end 不受影响', () => {
  const chunk = { type: 'block-end', index: 3, block: { type: 'text', text: 'hi' } }
  const out = repairChunk(chunk, createBlockState(), 'p')
  assert.equal(out, chunk, '必须返回原引用')
})

test('createBlockState：真实值优先，重复登记不被合成值覆盖', () => {
  const s = createBlockState()
  s.note(1, { id: 'call_real0000000000000000001', name: 'pwsh' })
  assert.equal(s.idFor(1), 'call_real0000000000000000001', '已登记真实 id 不应被生成值替换')
  s.note(1, { id: '', name: '' })
  assert.equal(s.idFor(1), 'call_real0000000000000000001', '空值不得覆盖真实值')
  assert.equal(s.nameFor(1), 'pwsh')
  assert.match(s.idFor(2), /^call_/, '未知 index 首次访问即生成')
  assert.equal(s.idFor(2), s.idFor(2), '同一 index 返回稳定 id')
})

test('resolveConfig 默认值与类型收敛', () => {
  assert.deepEqual(resolveConfig(undefined), {
    enabled: true,
    placeholderName: DEFAULT_PLACEHOLDER_NAME,
    debug: false,
    traceFile: undefined,
  })
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ placeholderName: '  ' }).placeholderName, DEFAULT_PLACEHOLDER_NAME)
  assert.equal(resolveConfig({ placeholderName: ' foo ' }).placeholderName, 'foo')
  assert.equal(resolveConfig({ debug: 1 }).debug, false)
  assert.equal(resolveConfig({ traceFile: 'C:/x/t.jsonl' }).traceFile, 'C:/x/t.jsonl')
})

test('apply 接线：注册 llm/stream 并返回已清洗的流', async () => {
  const handlers = {}
  const warnings = []
  const ctx = {
    logger: { info() {}, warn(msg) { warnings.push(msg) }, error() {} },
    on(event, handler) { handlers[event] = handler },
  }
  apply(ctx, { placeholderName: 'sentinel_tool' })
  assert.equal(typeof handlers['llm/stream'], 'function')

  const out = await collect(handlers['llm/stream']({ purpose: 'session-title' }, () => poisonStream()))
  const end = out.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.equal(end.block.name, 'sentinel_tool')
  assert.match(end.block.id, /^call_/)
  assert.ok(warnings.some((w) => w.includes('repaired malformed tool-call chunk')), '应输出修补日志')
})

test('apply disabled 时不注册监听器', () => {
  const handlers = {}
  apply({ logger: { info() {}, warn() {} }, on(e, h) { handlers[e] = h } }, { enabled: false })
  assert.equal(handlers['llm/stream'], undefined)
})

test('onRepair 上报 index/where/id/name', () => {
  const events = []
  const state = createBlockState()
  repairChunk({ type: 'tool-call-delta', index: 4, id: '' }, state, 'p', (e) => events.push(e))
  repairChunk({ type: 'block-end', index: 4, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } }, state, 'p', (e) => events.push(e))
  assert.equal(events.length, 2)
  assert.equal(events[0].where, 'tool-call-delta')
  assert.equal(events[1].where, 'block-end')
  assert.equal(events[0].id, events[1].id)
  assert.equal(events[1].name, 'p')
  assert.equal(events[1].placeholder, true)
  assert.equal(events[1].index, 4)
})

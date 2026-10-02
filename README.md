# dsh-plugin-toolcall-fix

修复「工具出错后对话无法继续」的根因：模型/provider 偶发产出**空 `id` / 空 `name` 的退化 tool-call 块**，导致 v4 会话日志校验拒绝落盘、或下一轮请求被 provider 400。

- 报错一（落盘被拒，回合从此卡死）：
  `format v4 tool/result at seq 139 requires toolCallId matching its tool source`
- 报错二（历史回放被拒）：
  `400 messages[199].tool_calls[i] is missing a function name`

## 根因

MiMo（xiaomi / openai-completions 适配器）偶发产出退化块：

```json
{ "type": "tool-call", "id": "", "name": "", "arguments": "{}" }
```

两条失败链（均有实测样本）：

1. **空 id** → assistant 消息广告 `id:""`、`tool/call` 携带 `callId:""`；当 dispatch 产生
   tool/result 要落盘时，`assertV4ToolResultMessage` 拒绝非空 toolCallId → **写入失败、回合中断**。
   日志尾部停在未闭合的 `tool/call`；之后每一轮的崩溃恢复合成 closer 又用空 callId
   → 同一个错误永久重放 → **该会话彻底无法继续**。
2. **空 name** → 会话能写（v3 时代无此校验），但下一轮请求回放历史时 provider 校验
   `function name` 必填 → **400，回合失败**。

证据样本：

- `session-d724c0f7-66f8-45da-ba6e-7f6aa01dad1d`（v4）seq 137 空 id/name 块、seq 138 `callId:""`，日志止于 138。
- `session-aec5e44d-f348-4907-90ea-2d470d463648`（v3）seq 474/477/478 空 id/name，后续 seq 482/491/500 连续 400。

## 修复（两部分）

### 1. 预防：`llm/stream` 流内清洗（本插件）

在公开的 `llm/stream` waterfall 里对 chunk 做**最小字段修补**（`lib/sanitize.js`）：

| 畸形 | 修补 |
| --- | --- |
| `tool-call-delta.id` 为空 | 补合成 id `call_` + 24 hex（同 index 全程一致） |
| `block-end` 的 tool-call 块 `id` 为空 | 补合成 id（优先复用该 index 已见到的 provider 真实 id） |
| `block-end` 的 tool-call 块 `name` 为空 | 优先复用 delta 中的真实 name，否则换占位名 `invalid_tool_call` |

设计约束：

- **只改字段，不增删块、不改顺序** → 对 `llm-invariant` 流校验与 `BlockAssembler` 完全透明。
- **健康 chunk 同引用透传**，零开销。
- 占位名不命中任何已注册工具 → dispatch 走 unknown-tool **错误结果**路径：错误结果带合法
  callId，可以正常落盘；模型看到错误后可自行重试，对话不再中断。历史回放也有名字，不再触发 400。
- 每次 `llm/stream` 新建清洗器实例，合成 id 状态绝不跨流共享。

### 2. 修复：已被毒化的存量会话 `scripts/repair-sessions.mjs`

```bash
node scripts/repair-sessions.mjs            # dry-run，只报告
node scripts/repair-sessions.mjs --write    # 备份 .bak → 改写 → 写后解码自验
```

- 对 v3/v4 同构：补 assistant 块 id、`tool/call` callId/name、v3 wrapper+source callId、
  错误文案 `unknown tool ""` → `unknown tool "invalid_tool_call"`，以及 `data.stream` 内的记录。
- 先写 `.tmp` 再覆盖，原文件备份为 `<file>.bak`；写完重新解码自验，失败则放弃改写。
- 已执行：5 个中毒会话全部修复（1 个 v4 + 4 个 v3），并删除其过期投影缓存。

## 校验

```bash
npm test                      # 14 个单测：修补正确性、结构不变、健康透传、apply 接线
node scripts/scan-sessions.mjs    # 全量会话日志校验（v3+v4 生命周期/空 id/配对）
node scripts/verify-install.mjs   # 以 profile 为 cwd 裸包名加载 → apply → 真实中毒流端到端
```

当前状态：

- `npm test`：14/14 通过。
- `scan-sessions`：131 个文件，**0 error**（唯一 WARN 是既有的 0 字节空文件，与本修复无关）。
- `verify-install`：PASS（junction、exports、apply 接线、真实中毒流修补全通）。
- 宿主 `plugin_manager list_plugins`：`include:toolcall-fix` 已注册、`fiberPhase: active`。

## 安装（desktop profile，已完成）

1. `profiles/desktop/package.json`：
   - `dependencies` 加 `"dsh-plugin-toolcall-fix": "link:D:/Codes/dsh-toolcall-fix"`
   - `dsh.profile.bundles` 数组加 `"dsh-plugin-toolcall-fix"`
2. `profiles/desktop/pnpm-lock.yaml` importers 段加对应 link 条目。
3. `profiles/desktop/node_modules/dsh-plugin-toolcall-fix` → junction 指向本仓库。
4. bundle 配置来自本包的 `cordis.patch.yml`（`dsh.bundle.patch`），profile 的
   `cordis.patch.yml` 无需重复行——与 `dsh-plugin-llm-request-guard` 同模式。

## 配置（`cordis.patch.yml` 的 config 段）

```yaml
enabled: true
placeholderName: invalid_tool_call   # 空 name 的占位工具名；须不命中已注册工具，charset ^[A-Za-z0-9_-]{1,64}$
debug: true                          # true 时写 $DSH_HOME/toolcall-fix.trace.jsonl（apply/llm-stream/repair，均有上限）
traceFile: ''                        # 可选，覆盖 trace 落点
```

## 注意事项

- **改 `lib/` 代码后必须重启 DSH 宿主**：模块 HMR 排除 node_modules，profile 热重载不会把新
  代码应用到运行中的实例（与 dsh-400fix 同一实测结论）；bundle 注册状态可热更新，但已加载的
  模块会留在 Node ESM 缓存里。`debug` 的 trace 因此也在**下次重启后**才会出现。
- 修复会话前先备份（`--write` 自动生成 `<file>.bak`）；`.bak` 不被 scanner 匹配，不会干扰校验。
- `session-bb39e3d0…` 是 0 字节文件（会话创建中断的残留），scanner 记为 WARN 而非 error。

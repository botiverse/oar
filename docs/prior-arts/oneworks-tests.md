# OneWorks tests / CI 核查

固定 SHA `6b5f3bbc785539e7fe208f3501e332e1a7c19709`。只读，未安装/执行仓库脚本或测试。

## 实际测试策略

1. **有意设计的统一离线 CLI harness**：`scripts/adapter-e2e/harness.ts:25-60` 启动本地 Mock LLM，四个 adapter Claude/Codex/OpenCode/Pi 走真实 wrapper/CLI。`runners.ts:127-180` spawn 执行 wrapper，读取 hook log、managed artifacts；不是整体替换 Adapter 的假集成。`mock-llm/server.ts:106-126` 提供 OpenAI Responses / Chat Completions。
2. **同 suite 参数化场景**：`cases.ts:156-210` 公用 expectations 检查 GenerateSystemPrompt、TaskStart、SessionStart、UserPromptSubmit、Stop、按支持情况 Pre/PostToolUse；mockTrace 检查请求数、工具名、至多一次工具调用、最终响应。`assertions.ts:80-91` 再验证 exit code、allowed transport、stable file snapshot。`cases.ts:451-462` 列 11 case：四家 read-once/direct-answer + Codex apply patch、两项 transcript injection。覆盖目标是 OneWorks 的 hook/managed asset 和 CLI 整条接入路径，不能扩大解释成全部 AdapterSession 控制能力矩阵。
3. **合成事件边界明确**：`cases.ts:332-361` 的 Codex MCP bridge case 构造 `mcp_tool_call`/output；`runners.ts:110-124` 直接追加原生 transcript。因此这是恢复/bridge 行为回归，不能称真实 LLM 自主 MCP 委派。
4. **低层 fake 也存在**：Codex `packages/adapters/codex/__tests__/session-rpc.spec.ts:25-38` mock hooks+spawn，保留 Session/RPC 实现；Claude `packages/adapters/claude-code/__tests__/session.spec.ts:11-29` mock prepare/accounts/spawn；Goose `packages/adapters/goose/__tests__/session.spec.ts:51-78` 将 CLI path 指向 fake-goose-acp 真实子进程。Goose `174-200` 真正跨两次子进程创建/resume，检查 native id 被复用、不新建 session、不重复发历史 message。

## 门控与 CI

- `scripts/__tests__/adapter-e2e/adapter-e2e.spec.ts:7-8` 默认 skip，仅 `ONEWORKS_RUN_ADAPTER_E2E=1` 启用。`scripts/cli.ts:72-95` 的明确 adapter-e2e test 入口设置门控。
- 搜索完整 `.github/workflows`，未见 adapter-e2e 或该 env gate 的触发。`quality.yml:392-422` 的 PR quality 主检查为 lint/format/env contract/typecheck/client build，不是 adapter unit/E2E runtime 执行。
- 其他 workflow 有 Relay/Chrome extension/release-guard 专用测试；不能冒充通用 adapter 持续验证。
- 没有发现该统一 suite 的 live model API 模式；它的目标显式是离线 LLM mock。不能由此推断产品不可靠，只能说当前默认 CI 未见持续执行 adapter flow 的证据，真实账号/厂商服务差异不在该 suite 的验证边界。

## 证明“有意识设计”的具体测试

- `packages/runtime-protocol/__tests__/runtime-protocol.spec.ts:15-45` 测 semver兼容；`49-63` 测 unknown additive fields 在 JSONL parse/serialize 后保留，是向前兼容契约而非只测已知字段。
- `packages/types/__tests__/adapter.spec.ts:33-110` 在临时磁盘写真实 npm package exports 和可选 capability。`316` 起测试 malformed capability 或缺少内部依赖不得静默伪装为 unsupported。这保障动态插件发现能区分“能力不存在”与“安装坏了”。
- `packages/types/__tests__/plugin-public-types.spec.ts:10-46` 用 `@ts-expect-error` 挡 private discovery root/sourceRoot/projectHome/workspaceFolder 进入公开类型。这是编译期边界保障；单跑 Vitest 并不执行类型诊断，应与 typecheck 联合解释。
- `packages/runtime-broker/__tests__/client.spec.ts:152-200` 用 fetch fake 制造响应送达不明，断言 responder 重试 2 次而 handler 只执行 1 次。broker 另有 lease heartbeat/admission、owner-scoped operations、nonsettling cleanup、stale event gap 测试。关注的是执行语义和故障恢复，明显超出简单 adapter shape。

所有链接可由以下固定 base 加路径/行号组成：

`https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/`

- [harness](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/adapter-e2e/harness.ts#L25-L60)
- [共用 expectations](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/cases.ts#L156-L210)
- [参数化11case](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/cases.ts#L451-L462)
- [snapshot断言](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/assertions.ts#L80-L91)
- [默认gate](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/adapter-e2e.spec.ts#L7-L34)
- [CLI设置gate](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/cli.ts#L72-L95)
- [PRquality](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/.github/workflows/quality.yml#L392-L422)
- [schema保留unknown](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-protocol/__tests__/runtime-protocol.spec.ts#L49-L63)
- [npm exports fixture](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/__tests__/adapter.spec.ts#L33-L110)
- [plugin public type边界](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/__tests__/plugin-public-types.spec.ts#L10-L46)
- [broker幂等故障回归](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-broker/__tests__/client.spec.ts#L152-L200)

## 对 OAR 的支持和挑战

OneWorks 与 Paseo 同时证明跨 coding-agent 共性不是假需求，也反证“没人抽象过统一层”。统一真实CLI+mock LLM harness 与 OAR sea-trial 的主意高度重合，本身不是唯一性。

有统一 suite、协议兼容、capability discovery 出错语义、broker幂等回归，不能把整个项目归为用户驱动补丁堆积。有 conscious architecture 不妨碍其保留原生版本兼容和产品特例。静态代码不能推导用户规模与补丁因果。

Paseo 的成熟点在 session lifecycle/native child 建模，抽出为第三方库仍要剥离 manager/工具/UI语义；OneWorks 已有 npm分包和public boundary测试，更接近可消费部件，但离线suite围绕自己的CLI/hooks/资产，提取仍有宿主配置与能力定义成本。OAR必要性更取决于可独立采用的窄runtime契约、版本兼容成本、raw保真和故障conformance是否有净收益，而不是adapter数量/统一send接口。

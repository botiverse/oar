# Lody 多 Agent 接入抽象层与测试层调研

调研基线：默认分支 `main`，固定 commit `c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29`，提交时间 2026-09-08 11:40:52 +08:00。只读分析源码、测试和工作流，未安装依赖、未执行仓库脚本/测试。按根仓库 gitlink 额外读取 Core/Codex/Claude 三个公开子模块；不把子模块能力自动算作 Lody 已接入能力。

## 结论

Lody 最值得借鉴的是 **ACP 协议接入 + 独立的持久会话编排控制面 + 针对竞态/恢复的测试体系**，不只是几个 provider adapter。它同时处理三类东西：可替换的 coding-agent runtime；一个 runtime 自带的 subagent/background task；Lody 自己创建、调度和收集结果的独立会话。第三类已经有代码实现，不能把它归为仅支持多 provider 的聊天壳。[会话 MCP 实现](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/mcp/lody-mcp-server.ts#L4310-L4383) / [operation 类型](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/session-orchestration.ts#L31-L68)

## 1. 接入抽象层

### 三段结构：Launch → ACP Client → 产品会话

- **启动/分发层**：`cliType` 区分 builtin、registry、custom。统一 `ResolveACPSettingInput`/`ResolvedACPProcessLaunch` 承载 agentType、自定义命令、runtime override、env、command/args、能力来源版本。内置 Codex/Claude/Kimi/Grok 使用固定 runtime/adapter；registry 由静态生成目录映射；custom 的能力缓存版本由序列化 launch spec 推导，命令变化即使没有 package version 也会失效。这比单纯 `providerId -> constructor` 多处理了安装、版本、能力缓存一致性。[setting.ts:58-110,121-175,188-218](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/setting.ts#L58-L218)
- **协议层**：一个共享的 `AgentClient implements acp.Client` 管 initialize、new/load/resume/fork、prompt、cancel/close、权限、文件/terminal、通知回调。并非每家各实现一个相同的大 `SessionAdapter`；原生差异主要在独立 ACP adapter 子模块，宿主仍留有 Kimi resume 优先、Grok terminal 和 Codex title 等兼容分支。[AgentClient options/state](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client.ts#L574-L669) / [生命周期选择](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client.ts#L1780-L1894) / [公开 adapter 子模块边界](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/.gitmodules#L1-L18)
- **产品会话层**：dispatch watcher 根据持久文档的 user-turn activation 检测待处理输入；execution service 执行单 turn；session/manager 管 runtime；fork/edit-and-resend/preparation/worktree 是独立服务。会话消息不直接等于一个临时 RPC 调用。[职责索引，文档](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/session/README.md#L3-L29)

### Capability 不是一组宽泛 boolean

标准 ACP 能力（load/resume/close/fork、HTTP MCP）在 initialize 后协商，宿主同时检查 advertised capability 与 SDK 方法是否存在；缺失 resume/fork 是明确错误，避免悄悄创建新会话造成上下文丢失。[agent-client.ts:1780-1894](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client.ts#L1780-L1894)

扩展独立发布为 `acp-extension-core`，通过 `agentCapabilities._meta.lody`、session `_meta.lody` 和 `_lody/...` methods 表达。扩展有 version；尤其 steering 不止 `supportsSteer`，还声明 `transport: request|prompt`、`upstreamTurn: same|handoff`、`configPolicy: active|apply`；subagents 拆 lifecycle/list/cancel/output。这直接表达了同一功能在不同 runtime 上的语义差异。[Core 能力类型，子模块 SHA 7bc6332](https://github.com/LodyAI/acp-extension-core/blob/7bc6332d3f007876895b4a3a827be0060f4d5318/src/capabilities.ts#L1-L43)

`AgentRunConfigSelection` 允许上层以 model/reasoning/fast/plan 语义选择，映射成 runtime 实际暴露的 ACP option id。区分当前模型测得的能力与每模型能力，返回 `validatedConfigIds` 和 `unverifiedSelections`，避免拿模型 A 的缓存验证模型 B；Codex plan 是 collaboration option，Claude plan 是 permission mode。[acp-run-config.ts:1-105](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/acp-run-config.ts#L1-L105)

并发还有启动资源层：`AcpSessionStartGate` 限制 **spawn + initialize + new/load** 的同时执行数，默认 2，支持排队取消并 finally 释放。这不是限制运行中 agent 数量，而是缓解一轮并发恢复的进程/原生 home 竞争。对多 agent 宿主非常实际。[acp-session-start-gate.ts:3-12,62-115](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/acp-session-start-gate.ts#L3-L115)

### ID、事件和 raw 保真

- 宿主 `SessionId` 与 `ACPSessionId` 分离。AgentClient 只接当前 ACP session 的通知，替换后旧 session 迟到事件会丢弃。持久记录归属是明确的目标 assistant entry/current host turn；没有归属且未显式允许 autonomous entry 的事件不能自行挂到历史尾部。[旧 session fence](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client.ts#L899-L920) / [turn 归属](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/lib/acp/history.ts#L134-L188)
- 原生 subagent/background/scheduled 生命周期进入 `_meta.lody.task`，保留 `taskId`、`parentTaskId`、`parentToolCallId`、model、状态等，再归一化成 first-class `subagent_task`，按 taskId 聚合。legacy Claude/Kimi raw carrier 仅为迁移兼容；不是每条 lifecycle 都作为普通 tool 文本反复追加。[task metadata 解析](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/acp/claude-subagent-task.ts#L5-L12) / [父子和 tool id 映射](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/acp/claude-subagent-task.ts#L64-L110)
- **不是无损 raw event store**。入口 schema 对 `_meta`/额外字段 passthrough，允许 unknown rawInput/rawOutput；但产品持久历史明确 compact/sanitize，terminal 仅保留有界输出并在结束物化，通用 rawInput/rawOutput 默认剥离（scheduling tools 例外）。usage、图片 raw 通知也可能转去独立 pipeline。适合协作文档体积控制，不宜拿持久 history 当原生调试/审计日志。[宽入口](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/acp/schema.ts#L14-L22) / [raw schema](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/acp/schema.ts#L97-L117) / [持久投影边界](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/lib/acp/history.ts#L130-L158) / [剥离规则](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/acp/history-apply.ts#L1209-L1229)

## 2. 多 Agent 编排不是 ACP adapter 的职责

Lody app-level 编排经内建 MCP `session_create/create_many/chat/chat_many` 接受 durable operation；调用方提供 operationId，工具接受后异步返回，完成时给发起会话自动 continuation。子会话独立，有 parentSessionId；选择机器/config/Role/runConfig 是产品调度，原生 provider subagent 则是 agent 内部任务。宿主还提供能力门控的 `_lody` subagent list/cancel/output，但不能把它当跨 provider 会话编排接口。[MCP create 实现](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/mcp/lody-mcp-server.ts#L4310-L4383) / [原生 subagent 调用](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client.ts#L1335-L1375)

持久性有自己的实体：SQLite WAL operation store、operation item 的 `(sessionId,userTurnId)`、delivery completion、coordinator。key 是 `(requesterSessionId,operationId)`，command canonicalize/fingerprint 防止同 id 不同语义重用；target input materialization 有 claim；delivery 有 claim/prepare/start 与 worker boot fencing。已到 provider 后失联是 `uncertain`，不能假定没执行而自动重放；只确认在 provider 前失败才有限恢复。这里是多 agent 系统真正难的部分。[key/fingerprint/accept 代码](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-store.ts#L375-L541) / [恢复 fencing 代码](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-store.ts#L835-L950)

编排链深度限制为 5。要注意它不承诺 root deadline 会杀死所有 child：deadline 完结本次等待/收集操作；显式 operation cancel 才有 best-effort remote cancel。pending user 输入优先于后台 delivery continuation，不用后台完成结果抢占用户。[深度限制常量](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/packages/shared/src/session-orchestration.ts#L6-L13) / [深度检查](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/mcp/lody-mcp-server.ts#L2308-L2324) / [timeout 不 cancel 的具体测试](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-coordinator.test.ts#L826-L869)

限定：Codex 子模块还实现 AIR/native child session 协议，包括 thread→child session 路由、generation、buffer 等；但 Lody 当前 initialize 没广告 AIR nativeSubagentSessions，且 host 丢弃其他 ACP session 通知，不能声称 Lody UI 已按该协议完整承载原生 child transcripts。这里只把 `_meta.lody.task` 聚合和宿主独立 session 编排算作已核实接入。[Lody initialize](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client.ts#L1731-L1758) / [子模块能力 absent 时走 legacy](https://github.com/LodyAI/acp-extension-codex/blob/9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f/src/subagents/CodexSubagentEventRouter.ts#L90-L103)

## 3. 测试层：每层究竟替换什么

| 层 | 保留真实逻辑 / 替身位置 | 能证明什么、不能证明什么 |
|---|---|---|
| 能力/配置/事件单元测试 | 真 normalize/resolve/projection；构造协议数据 | provider 差异规则与兼容性，不能证明当前真实 agent 输出符合 fixture |
| AgentClient 生命周期 | 真 AgentClient；mock `@agentclientprotocol/sdk.ClientSideConnection` 方法 | 验 handshake、load/resume、新/替换 session、config 路由；不穿真实 SDK 序列化，也不验证 provider 原生映射 |
| Native adapter 子模块测试 | Codex 真 AppServerClient→AcpClient→AcpServer；mock 底层 JSON-RPC；Claude 真 ClaudeAcpAgent、注入 SDK Query async generator/session state | 验 native→ACP 映射与异步顺序；部分 helper mock `getSessionState/turnStart`，不是完整启动链 |
| ACP wire contract | Codex 子模块另用真实 ACP SDK client/server 流 | 验 capability/结构化错误确实跨 SDK wire，不能代表真实 Codex binary |
| fixture replay | 真 LoroRepo/SessionDocument，回放 ACP fixture，比较 batched vs 单条投影 | 证明同一输入不同批次的持久化等价；这是 ACP→history，非 native→ACP，也非 raw 无损归档 |
| orchestration model + integration | reduced executable state model；实际 coordinator + SQLite + 可控 docs/clock/failure；另真 Mirror 集成 | 分开检查状态机安全与真实实现故障恢复；模型证明不等于实现证明，两套需要互补 |
| Desktop regression E2E | 真 Electron + bundled CLI + git/worktree；scripted ACP 子进程 | 产品链路、流式/停止/归档/删除/资源释放；不测真实模型、认证、各 provider mapping |
| Opt-in live registry E2E | startLocalAcpAgent 真进程，OpenCode/Kimi/Kimi Code 参数化同 suite | 真 agent handshake/prompt/config/load/resume；环境依赖、耗时且不在默认 CLI test |

证据：

- AgentClient mock 在 SDK connection 边界：[agent-client-session-preparation.test.ts:5-30](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/agent/agent-client-session-preparation.test.ts#L5-L30)。直接 sessionUpdate 测试还会设置私有 acpSessionId，值得避免误称完整 adapter contract test：[session-info test:19-52](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/tests/agent-client-session-info.test.ts#L19-L52)。
- Codex 真实 mapper 链与 mock connection：[acp-test-utils.ts:95-120](https://github.com/LodyAI/acp-extension-codex/blob/9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f/src/__tests__/acp-test-utils.ts#L95-L120)、[323-350](https://github.com/LodyAI/acp-extension-codex/blob/9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f/src/__tests__/acp-test-utils.ts#L323-L350)。具体 child permission root-route / collab tool id 断言：[collab-agent-events.test.ts:116-139](https://github.com/LodyAI/acp-extension-codex/blob/9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f/src/__tests__/CodexACPAgent/collab-agent-events.test.ts#L116-L139)。真实 ACP wire 的 capability 和 sanitized failure 断言：[typed-session-failure-wire.test.ts:13-77](https://github.com/LodyAI/acp-extension-codex/blob/9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f/src/__tests__/CodexACPAgent/typed-session-failure-wire.test.ts#L13-L77)。Claude 真 agent + Query generator 注入：[acp-agent.test.ts:122-155](https://github.com/LodyAI/acp-extension-claude/blob/414718e5238a7ed5da0ff23bec31bff4450ffa5f/src/tests/acp-agent.test.ts#L122-L155)。
- replay suite 同一 `it.each` 五种 Codex/Claude/Kimi ACP fixture，用真实 Loro 分别逐条/batch 得到 history 后等价比较：[acp-history-batching-equivalence.test.ts:54-96](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/tests/acp-history-batching-equivalence.test.ts#L54-L96)。fixture 文件有 captured/sample 命名，但此次未核验每份采集来源，因此不把它们全部称为合成或全部称真实捕获。
- **最值得借鉴的测试**：`enumerateOrchestrationModel(9)` bounded exhaustive traces；具体 trace 测 pending user 优先、archive/restore、crash 后 started→uncertain，避免重复执行。[operation-model.test.ts:13-44](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-model.test.ts#L13-L44) / [149-180](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-model.test.ts#L149-L180)。实际 coordinator harness 使用 SQLite、固定 clock、可注入 materialization/history/sync failures：[operation-coordinator.test.ts:22-77](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-coordinator.test.ts#L22-L77)。真实实现还有 exited worker 后不可重放 provider 的测试：[2469 起](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/src/orchestration/operation-coordinator.test.ts#L2469-L2528)。
- 不只 mock 文档：A→B→C 的 real Mirror 进度反馈回归检验 unchanged update 不触发无限 reconciliation，同时后续 child completion 仍发布：[operation-progress-feedback.test.ts:14 起](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/tests/operation-progress-feedback.test.ts#L14)。
- Live registry 是明确的同 suite 多 provider 参数化：`LODY_E2E=1` gate，数组有 OpenCode、Kimi、Kimi Code；每个跑 new session capability、prompt，包含期待 pong 的真响应。[registry-agents.e2e.test.ts:54-85](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/tests/e2e/registry-agents.e2e.test.ts#L54-L85) / [168-211](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/tests/e2e/registry-agents.e2e.test.ts#L168-L211)。未发现全体 builtin+registry 统一 mandatory conformance suite 的证据，不应将此局部 suite 扩大为全 provider coverage。
- Desktop fake 放在 **ACP 外部进程边界**，是小型真 stdio ACP server，支持 initialize/new/prompt/cancel/close，而不是 UI mock reply。[scripted-acp.mjs:51-136](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/e2e/fixtures/scripted-acp.mjs#L51-L136)。Electron harness 用临时 durable 目录、临时 endpoint、隔离 env，启动 built main：[electron-harness.ts:110-155](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/e2e/src/support/electron-harness.ts#L110-L155)。

## 4. CI 与质量门禁的实际边界

默认 CLI Vitest 排除 `*.e2e.test.ts`；`LODY_E2E=1` 才反过来仅选 live E2E。[vitest config:15-19](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/apps/cli/vitest.config.ts#L15-L19)。根 CI prepare ACP adapters，然后 `test:ci` 或 affected package tests；**根 test:ci 明确排除 Codex/Claude 子模块测试**，affected runner 也同样排除。编译 adapter 不等于跑 adapter tests。[CI:181-199](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/.github/workflows/ci.yml#L181-L199) / [root package.json test:ci](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/package.json#L22-L27) / [affected runner:7,39-50](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/.github/scripts/run-ci-tests.mjs#L7-L50)。

独立 Desktop PR CI 根据 critical paths/labels 选 smoke/full，macOS 构建真实 app + CLI，运行 Cucumber/Playwright journeys，保留失败视频/产物；这是 scripted ACP 系统回归，不是 live LLM gate。[e2e-smoke.yml:53-114](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/.github/workflows/e2e-smoke.yml#L53-L114)。

另有 Scout soak 与 acceptance lane：同 harness 做重复生命周期和资源回收，Scout 为 informational，防止机器 RSS/CPU 噪声污染 merge gate；有疑似泄漏须独立复现、找 retained path，然后加入窄而确定的 regression。[Scout 合同/文档:3-6,12-19,63-69](https://github.com/LodyAI/Lody/blob/c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29/e2e/SCOUT.md#L3-L69)。因此测试层不应只总结成 unit + e2e，应区分协议契约、投影不变量、操作恢复、系统流程、资源趋势、真实 runtime 兼容性。

## 5. 对已有 runtime/session/ACP + replay/mock/live 的 OAR 的增量建议

1. **优先研究持久 operation/delivery 与故障语义，而非再加一层 adapter。** 区分 accepted、input durable、provider started、settled、uncertain；每次执行用 source turn、attempt token、worker boot 归属。保证明确的 at-most-once/不确定执行处理，比承诺泛化 exactly-once 更实际。
2. **把可选能力升级为语义契约。** steering 的 same/handoff、active/apply；load 与 resume 的历史重放差别；native subagent 管理与 app-level 子会话分别建模。不能只靠 supportsX 消除 provider 差异。
3. **加状态机不变量/竞态测试。** bounded model + 真实 coordinator 故障注入；重点测后端已接受但本地响应丢失、跨 replica 尚未同步、旧 session 迟到事件、prepared/started crash、用户输入和后台结果同时到达。模型与实现测试要有同一批不变量。
4. **保证 replay 穿过正确的边界。** OAR 若已有 raw projection replay，新增价值是 native transport→真实 adapter→统一事件的 replay，以及真实 ACP SDK wire roundtrip；别用顶层 fake session 冒充 adapter 测试。Lody 根 CI 排除 adapter suite 的做法是覆盖盲区提醒。
5. **独立做启动风暴与资源释放的测试/控制。** 限制启动阶段而非运行阶段；重复创建/恢复/终止后观察 ACP PID、terminal、worktree 的真实消失。高噪声资源趋势独立于 blocking deterministic checks。
6. **保留 OAR 原始事件层的优势。** Lody 的 CRDT 紧凑历史与 raw 调试日志是不同需求。若 OAR 已有 raw fixture/event log，别用 Lody 的有损持久投影取代它；可以沿用“原始事实 + UI 投影”双层并明确各自 retention。

局限：这是静态设计调研，不声称所读测试全部通过；未覆盖所有子模块或商业云后端。根仓库公开边界明确不含 hosted backend/web/mobile source，本报告只评价可见实现。repo Agent Note/doc checks 因只读研究及不执行脚本约束未更新/运行。

# Synara：多 agent 接入抽象与测试设计（源码核验）

- 调研日期：2026-09-08。默认分支 main，固定 commit `8599826d75d9932e69c301f2441f585da8f211e2`，2026-09-06 发布 v0.8.3。
- 只读浅克隆和源码检查；没有安装依赖、执行仓库脚本或运行测试，因此下文是“已实现与已定义的测试”，不代表我验证当前测试均通过。
- 不依据 .plans / plans / advisor-plans 推断已交付能力。AGENTS.md 中“Codex-first”与历史文件路径是过时架构介绍，以下以实际 Services/Layers、runtimeLayer 与测试为准。

## 结论

Synara 最值得 OAR 借鉴的并非接口长相，而是 **原生协议适配、持久化运行生命周期、宿主编排分别有明确测试替换点**。它已有三种不同层次的“多 agent”：

1. 九个 coding-agent runtime 的统一接入；
2. Codex/Claude 等 provider-native 子 agent 映射为宿主可见 child threads；
3. agent 经带线程凭据的 MCP 创建跨 provider 独立线程、发送消息、运行自动化。它不是只有多个 provider 选择器，也不能把 Claude 原生 Workflow 当成 Synara 自建的统一 workflow/DAG 引擎。源码入口：[九 adapter 注册](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts#L36-L64)；[native subagent](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3046-L3054)；[宿主 MCP 编排](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.ts#L1-L12)。

## 接入抽象

### 1. 契约 / 注册 / 组装

`ProviderAdapterShape<TError>` 提供 session start/resume、turn send/interrupt、approval/user-input response、session stop/list/has、read/rollback、stopAll、canonical `Stream<ProviderRuntimeEvent>`。steer、review、backgroundTask、stopTask、steerSubagent、native fork、models/skills/plugins/agents discovery 是可选方法。模型切换不是 boolean，而是 `in-session | restart-session | unsupported`；rollback 区分 native/restart-session；fork 缺失可让宿主回退到仅复制 conversation history。stopSession 明确要求未知/已停止线程幂等成功，这是清理 barrier 契约。[capabilities](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Services/ProviderAdapter.ts#L47-L85)；[session/turn/subagent](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Services/ProviderAdapter.ts#L98-L169)；[幂等清理、rollback/fork/events](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Services/ProviderAdapter.ts#L189-L255)。

Registry 只做 lookup，默认静态组装 codex、claudeAgent、cursor、devin、antigravity、grok、droid、opencode、pi；注册时校验 required methods、capability 对应的 optional methods，并拒绝重复 provider key。它是 TypeScript/Effect 服务注册，不是任意外部动态 plugin loader。形状 conformance 只证明声明和方法存在，不证明行为正确。[registry](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ProviderAdapterRegistry.ts#L32-L75)；[运行时契约检查](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/providerAdapterConformance.ts#L46-L93)。

`runtimeLayer` 用 Effect Layer 注入 adapter、credentials、session directory、runtime event repository，正式服务采用 `makeDurableProviderServiceLive`。统一核心之外保留 native 差异：Codex manager/app-server、Claude SDK、Cursor/Grok/Droid/Devin 共享 ACP、OpenCode/Pi native runtime 等；不把全部 runtime 强行改写成 ACP。ACP 的共享层分 session/runtime、通用事件、能力支持和各家扩展。[实际 runtime 组装](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/runtimeLayer.ts#L52-L118)；[Devin 的 ACP shared modules](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/DevinAdapter.ts#L73-L148)。

### 2. Session 生命周期是持久化状态机，不只是 Map<id,session>

`ProviderSessionDirectory` 存 app threadId → provider、status、lifecycleGeneration、resumeCursor、runtimePayload、runtimeMode；原生 resume cursor 有意留为 unknown，使 native session 恢复数据不被错误公分母约束。[durable binding](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Services/ProviderSessionDirectory.ts#L15-L44)。

每 adapter 单独 supervised pump：canonical event **先落 journal，再更新 binding，再 publish**；持久化失败原地重试当前事件，不能先消费下一事件，否则 terminal 丢失会让 UI 永远 working。stream 意外完成/defect 重新订阅；永久 decode failure 可以 durable quarantine 后继续，health 区分 recovering/degraded，并在连续成功后恢复。[journal-first 顺序](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ProviderService.ts#L1302-L1318)；[每 adapter pump 与 decode quarantine](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ProviderService.ts#L1606-L1631)；[retry/restart seam](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/providerRuntimeEventPump.ts#L114-L123)；[quarantine 自身也可靠重试](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/providerRuntimeEventPump.ts#L172-L203)。

尤其值得借鉴的是 **过期 generation 的 terminal 例外**：普通旧事件丢弃；但没有当前 generation，或者旧 terminal 的 turnId 仍是 durable binding 的 active turn 时允许收尾。纯粹“所有 stale event 都 drop”反而会吞掉 runtime death，制造 forever-working。[generation fence 的 terminal 例外](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ProviderService.ts#L1320-L1390)。

### 3. Canonical 与原生身份并存，raw 有限保留

`ProviderRuntimeEventBase` 有 app event/thread/turn/parentTurn/item/request IDs、lifecycleGeneration；`providerRefs` 独立保存 providerThreadId、providerParentThreadId、providerTurnId、parentProviderTurnId、providerItemId、providerRequestId。raw 是 source/method/messageType/unknown payload，事件类型还包含 `event.unmapped`。这能让 UI / orchestration 使用稳定宿主 ID，同时保留取消、恢复、父子归属所需的原生坐标。[raw 与 provider refs](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/packages/contracts/src/providerRuntime.ts#L20-L55)；[canonical identity](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/packages/contracts/src/providerRuntime.ts#L260-L274)。

**不是无损 raw event log**：callback ingress 设置 32 MiB 总字节预算、64 个 terminal reserve、单 event 512 KiB；超限事件若有 raw，会把 raw.payload 换成 `synaraTruncated: true` / originalBytes 标记，canonical payload 保留。若 OAR 要可再投影的原始记录，应将原始 trace 存储和 bounded UI ingress 分开，不能照抄此处就宣称 lossless replay。[raw 截断规则](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/providerRuntimeEventIngress.ts#L3-L50)；[2048 event adapter buffer](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Services/ProviderAdapter.ts#L49-L54)。

Claude 子 agent 用 Task tool_use_id 建 scoped context，分享父 query/session，但产生自己的 synthetic turn、usage、tool 追踪状态；providerRefs 路由到 `subagent:<parent>:<toolUseId>`。仅 parent_tool_use_id 不足以断言子 agent：async Bash progress 也带该字段，必须先识别 Task/Agent tool；settled 子任务迟到的 zombie tail 丢弃。[child context 策略](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3046-L3054)；[原生 refs](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3123-L3126)；[Task/Agent 与 async Bash 区分](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4575-L4601)。宿主 ingestion 则 materialize child thread：[子线程 ID](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts#L1914-L1930)。

### 4. 跨 agent 编排处于 MCP host 层

`AgentGateway` 暴露 `synara_create_threads`：1–20 个 exact batch，每项显式 target/model、project、local/worktree、baseRef、runtimeMode；requestId 为幂等键。工具要求 thread:write 且 active turn，预检失败不创建，durable retry 重放已记录操作。消息工具 queue 为默认，steer 不支持时排队。这里不保存 orchestration state，而是调用现有 engine/query/automation/git 服务。[跨 provider creation plan](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.ts#L243-L283)；[queue/steer](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.ts#L410-L427)。

原生 child 与 gateway 创建的 standalone thread 不应合并成一种“spawn”：前者共享 provider session/工具生命周期，后者有独立 target/worktree/初始 turn。Claude workflow 的 phases/agent plan/runtime snapshot 是解析原生 Workflow 数据和 transcript poll 的呈现契约，不代表 Synara 有统一跨 provider Workflow DSL。[Claude workflow 投影字段](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/packages/contracts/src/providerRuntime.ts#L539-L576)。

## 测试层：替换点决定证明范围

| 层 | 实际 seam | 能验证什么 / 不能验证什么 |
|---|---|---|
| Schema、pure helper、注册 | capabilities/methods、各种协议 mapper 函数 | schema 边界、unsupported、identity、shape 一致；不是 behavior conformance |
| 真 adapter + fake native boundary | Codex 的 FakeCodexManager；Claude createQuery → FakeClaudeQuery；Devin makeAcpRuntime fake | 保留 adapter 逻辑，验证 prompt/options/native event→canonical 的真实映射；不覆盖真 CLI/SDK 行为 |
| ACP shared runtime + 官方 SDK 模拟端 | 官方 SDK agent 真 subprocess，或 fake ChildProcessSpawner + 内存 byte streams | initialize/auth/session/prompt、早到通知顺序、取消、退出、epoch transition；没有真模型调用 |
| ProviderService / Orchestration integration | 顶层 TestProviderAdapter（canonical typed fixtures），真实 SQLite/Git/engine | persistence、projection、approval、checkpoint、rollback；**不覆盖真实 adapter 原生映射** |
| Browser / CI | Vitest browser + Playwright Chromium；按 workspace 分 shard | UI 行为与集成，不等于 live provider e2e |
| Opt-in 真 agent | CODEX_BINARY_PATH 和 SYNARA_CURSOR_ACP_PROBE | 存在特定 provider 的实际运行检查；不是默认 CI 全 provider 海试 |

关键证据与可复用测试案例：

1. **Adapter-level mapping**：Codex `FakeCodexManager extends CodexAppServerManager`，通过 makeCodexAdapterLive({manager}) 保留真 adapter，测试 session/started→canonical event。[fake manager](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/CodexAdapter.test.ts#L36-L58)；[真实映射测试](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/CodexAdapter.test.ts#L455-L495)。Claude 以 createQuery 注入 FakeClaudeQuery，保存 native SDK options 并驱动消息 async iterable：[SDK seam](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L447-L476)。Devin fake 的是 AcpSessionRuntime，包括 mode、events、session epoch、prompt/cancel：[ACP runtime fake](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/DevinAdapter.test.ts#L73-L122)。

2. **父子隔离精确断言**：Claude 子 agent 测试不仅检查显示文字，还检查所有 child events 的 parent refs、collab tool receiverThreadId、子 agent text/usage 都只进入 child meter、child turn.completed。另有 async Bash stays parent 回归测试。[child text/tool/usage identity](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L2335-L2392)；[async Bash 区分](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L2400-L2437)。

3. **官方协议参考实现作 oracle**：AcpSdkConformance 的模拟 agent 用仓库 fixture subprocess，但 handlers 与 wire 使用官方 @agentclientprotocol/sdk；检查 _meta 保留、early updates 排序、pending work 随进程退出失败、session cancel 与 generic $/cancel_request。还有反向“官方 client 对官方 mock agent”的检查。这超出只 stub 方法返回值。[真正 subprocess runtime setup](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/AcpSdkConformance.test.ts#L86-L110)；[协商与事件顺序](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/AcpSdkConformance.test.ts#L119-L203)；[generic cancellation](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/AcpSdkConformance.test.ts#L309-L340)；[reverse compatibility](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/AcpSdkConformance.test.ts#L344-L399)。

4. **确定性制造竞态窗口**：AcpSessionRuntime.epoch.test 用官方 SDK in-memory agent + fake spawner，通过 Deferred 卡住“pending buffer 已 capture、final epoch 尚未 install”窗口，此时送 session/update，再放行，断言事件 exactly once、pending 清零。这比 sleep 后期望没有重复更有效。[transport seam](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/AcpSessionRuntime.epoch.test.ts#L15-L18)；[race regression](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/AcpSessionRuntime.epoch.test.ts#L91-L153)。

5. **上层 replay 不能冒充原生 replay**：providerService.integration 只注册 fake codex，fixtures 已是 canonical typed events（甚至 TestProviderAdapter 内带 legacy→canonical 转换）。文件修改来自 harness `mutateWorkspace` 回调，不是 agent 真编辑。[顶层 fake registry](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/integration/providerService.integration.test.ts#L42-L63)；[文件修改回放](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/integration/providerService.integration.test.ts#L131-L159)；[fake 自行 normalize](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/integration/TestProviderAdapter.integration.ts#L102-L129)。Orchestration harness 的 provider 参数允许 fake 扮演不同 provider；只有 realCodex 分支改装真正 CodexAdapter：[provider 参数只是 fake label](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/integration/OrchestrationEngineHarness.integration.ts#L222-L248)；[真 Codex 分支](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/integration/OrchestrationEngineHarness.integration.ts#L271-L297)。

6. **持久化故障协议**：pump tests 专测“重试当前 event 不先消费下一项”、stream death restart、permanent failure quarantine 后继续、sustained success 从 degraded 恢复。[队列顺序故障注入](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/providerRuntimeEventPump.test.ts#L26-L68)；[quarantine 与恢复](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/providerRuntimeEventPump.test.ts#L108-L164)。

7. **Host orchestration 幂等/授权/补偿**：gateway tests 有 cross-provider create + initial dispatch、identical batch replay、不重复创建、并发 coalescing、同一 caller turn 第二个不同 plan 被拒绝、caller turn 结束拒绝破坏性操作、带 ownership token 的 worktree compensation。[跨 provider 创建](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.test.ts#L2368-L2406)；[exact batch replay](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.test.ts#L3213-L3251)；[并发 coalescing / plan lock](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.test.ts#L3326-L3406)；[worktree ownership compensation](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/agentGateway/Layers/AgentGateway.test.ts#L2875-L2931)。

### 是否有统一多 provider behavior suite？是否 CI 跑真 agent？

没有找到“一套相同 session/turn/cancel/resume suite 参数化跑九个真实 adapters”的实现。ProviderAdapter conformance 是形状检查；各 adapter 的测试密度/替换点不同。Orchestration integration 能切换 fake provider，但这不证明真实 provider 一致性。这里应表述为“未发现”，不从大量 test 文件推断覆盖全面。

真 agent 检查已实现：`CODEX_BINARY_PATH` opt-in 用实际 Codex 验证 runtimeMode 切换前后 provider thread 保持相同，并发送 “Reply with exactly ALPHA.”；Cursor probe 默认 skip，环境变量启用后运行 `cursor-agent acp` 做 initialize/auth、new/config/model switch。[真实 Codex opt-in](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/integration/orchestrationEngine.integration.test.ts#L272-L322)；[真实 Cursor opt-in](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/src/provider/acp/CursorAcpCliProbe.test.ts#L1-L49)。

当前 CI workflow 未设置上述两个 env；默认 unit 测试按 contracts/shared/scripts/desktop/web/server 分 shard；server script 串行 `vitest run --maxWorkers=1 --no-file-parallelism`；browser stable 拆三 shard，Linux geometry quarantine 移至 nightly 且 continue-on-error。因此**CI 主要验证 mocks/fakes、真实本地协议子进程、SQLite/Git/浏览器，而非真模型跨 provider e2e**。[unit shard](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/.github/workflows/ci.yml#L106-L147)；[server script](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/apps/server/package.json#L26)；[browser shard](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/.github/workflows/ci.yml#L149-L193)；[nonblocking geometry](https://github.com/Emanuele-web04/synara/blob/8599826d75d9932e69c301f2441f585da8f211e2/.github/workflows/ci-nightly.yml#L51-L55)。注意 @effect/vitest 的 `it.live` 不自动等于真 LLM；是否真实必须看 harness 和 env gate。

## 对 OAR 的建议（推论，不是 Synara 承诺）

优先借鉴：

- 在现有 runtime/session capability 上增加注册期 capability→method 验证；但真正的行为一致性仍以已有 sea-trial 为核心。
- 在 raw fixture projection replay 之外增加官方 ACP reference peer + wire-level test，防止 fake 与实现共用错误理解。
- 给生命周期 transition、stop/restart、late terminal 加可控 barrier/fault injection，覆盖旧 generation 收尾、durable cursor、journal retry；不要仅测 happy-path send。
- 明确 native refs、app identity 与 child ownership；加“parent_tool_use_id 但不是 subagent”的负例，以及 child token/tool 不能污染 parent 的断言。
- 将 live trace 存储与 bounded event delivery 分层：Synara raw 会截断，因此 raw 可回放性应单独立契约。
- 若 OAR 做 host-level agent fan-out，除了 spawn API，应有 exact plan/requestId、并发幂等、active caller turn authority 与 worktree ownership compensation。

谨慎借鉴：接口包含 voice/plugin/UI composer 等广泛可选功能；ProviderService 3214 行、ClaudeAdapter 6573 行、DevinAdapter 3468 行（此 commit 文件行数），复杂度已经集中在大模块。对已有更小 runtime/session 层的 OAR，不建议复制其大接口或完整 Effect 服务框架。其主要短板是不同 adapters 测试强度不均、缺统一真实 adapter 行为 matrix、默认 CI 不验证外部 CLI 版本漂移，而不是缺 test 文件。


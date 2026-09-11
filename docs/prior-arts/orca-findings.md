**Orca：统一 agent 层与测试设计**

基线：`main@1a8640adb6e86abb342a8025892300b2835f3e8e`，2026-09-08 调研。只读源码与测试/CI 静态核查，没有安装依赖或运行测试。规模较大，重点取结构化 session、终端运行边界及编排的代表性路径，不能据此给全部产品可靠性打分。

**核心判断。** Orca 已有相当明确的运行语义与故障模型，不能概括为“很多 CLI 启动命令加用户反馈”。它同时存在广泛 TUI/PTY 支持和更窄的结构化 agent-session；这两条路线保证不同。其复杂性来源于保留原生终端、跨宿主运行、native/TUI ownership handoff、持久会话与用户交互，不应将全部复杂性归为可由 OAR 消除的 runtime glue。

**接入和控制分层。**

- 终端路线运行原生 CLI，状态和身份来自 hook、执行宿主 process、launch、完成 hook、sleeping session、terminal title 等不同证据；代码给证据定义强弱顺序，避免把任何终端标题都当作 agent 身份。[证据枚举](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/shared/pane-agent-evidence-sources.ts#L1-L19)
- 结构化路线有 `StructuredAgentSessionAdapter`：acquire、dispatch、cancelTurn、answerPrompt、setOption、close，rewind/compact/background tasks 等可选。宿主拥有 journal/lease；adapter 回答 provider 是否接收请求，结果为 accepted/rejected/unknown。unknown 明确不可自动重发。cancelTurn 绑定具体 turn，避免用 session 全局 interrupt 杀掉用户没要求停止的新 turn。[契约](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/native-chat/agent-session-wire/structured-agent-session-adapter.ts#L91-L218)
- 当前结构化 router 实际列出 Claude/Codex，构造并连接到宿主 runtime；不能把 README 中“任意 CLI 支持”扩大为任意 CLI 都具备此结构化协议。[router](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router.ts#L5-L27)、[实际组装](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/runtime/structured-agent-session-runtime.ts#L280-L308)。源码旧注释中提到 phase 2，不应据此把已被组装的实现误判为纯计划；本次不核定其历史发行时间。
- Wire mutation 有 sessionId/clientOperationId/expectedRuntimeFence/fingerprint。历史有 epoch/cursor、tail/before/after、reset/tombstones；增量 batch 传当前 reduced state，重复应用收敛，非重复 append。它服务跨客户端同步和产品投影，不是所有 native event 的无损保真协议。[wire/history](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/shared/agent-session-wire.ts#L78-L185)、[mutation 身份](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/shared/agent-session-wire.ts#L218-L230)
- 宿主编排另外建模 Run、Task、Dispatch、Delivery、consumer_generation、mailbox、decision gate；这是应用任务系统，不是 adapter 扩展几个 spawn 方法。[编排实体](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/runtime/orchestration/types.ts#L1-L66)

**已经有精心设计的证据。**

1. 单写者所有权不能仅靠 TTL。lease adjudication 检查 pid+start time/spawn token，区分 first-hand exit、PID absent、identity mismatch 与 indeterminate；即使 lease 过期，不能证明旧 owner 已死就拒绝第二 writer。重启 claim 在完成 reconciliation 前不可写。[实现](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/shared/agent-session-lease-adjudication.ts#L1-L46)、[CAS](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/shared/agent-session-lease-adjudication.ts#L117-L181)
2. 事件落盘入口有字节/操作 watermarks、pauseReading/resumeReading、单独 lifecycle admission/barrier。失败和 backpressure 为明确状态；旧 stream cleanup 不应解绑新 stream。此处不是无限队列加 best-effort emit。[sink](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/native-chat/agent-session-wire/structured-agent-session-event-sink.ts#L12-L108)
3. SSH 边界文档明确 execution host 才能证明进程状态；断联是 unverifiable，不是 exited。文档也诚实列出 direct SSH 与 peer runtime 的控制面差别、有限 replay buffer、已知更新后无法接回旧 relay 等限制。这说明规范来自实际问题的提炼，同时仍存在已知问题；不是“有规范即已完全解决”。[SSH 设计说明](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/docs/reference/ssh-execution-boundary.md)

**测试替换点与具体价值。**

| 层 | 核实的测试边界 | 实际覆盖 |
|---|---|---|
| 纯契约状态决策 | 构造 lease/probe，调用真实 adjudicator | stale fence、并发 CAS loser、expiry 不授予第二 owner、uncertain reservation、restart |
| 真 adapter + fake native connection | Codex 注入 fake `openConnection`，主动推 notification/控制 child closed | 原生请求到统一语义映射、生命周期竞态；无真 Codex binary |
| 真 SDK + scripted fake CLI | 真实 Claude Agent SDK 驱动脚本化子进程 | SDK版本/未知frame/环境/argv/permission callback 的兼容性；不是模型测试 |
| OS integration | 创建真实 Node 子进程及孙进程，测实际 PID 消失 | cancel 的作用范围，保留 turn 之前已经存在的 descendant；无真 Codex binary |
| 产品 E2E | Electron + RuntimeClient + 真实 terminal | low-level dispatch release 后 pane/incarnation 保持可用；本例不证明模型自主编排 |
| live CLI | Claude binary + auth availability 条件启用 | 真实初始化、设置、路径等 fixture 难验证的行为 |

对应源码：

- [lease 测试](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/shared/agent-session-lease-adjudication.test.ts#L57-L184)
- [Codex fake connection](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/codex/codex-structured-session-adapter.test.ts#L42-L99)
- [真实 SDK + 假 CLI pins](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/claude/claude-agent-sdk-contract-pins.test.ts#L19-L61)
- [真实 OS 进程终止断言](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/codex/codex-structured-turn-processes.integration.test.ts#L34-L102)
- [真实产品 dispatch 释放测试](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/tests/e2e/orchestration-low-level-dispatch-release.spec.ts#L11-L97)
- [live CLI gates](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/claude/claude-structured-real-cli.test.ts#L17-L46)、[live 条件执行](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/claude/claude-structured-real-cli.test.ts#L97-L150)

特别有价值的回归：子 agent 在父 turn 结束后 57–87 秒才 completed。测试明确不把父 turn 边界当成子任务死亡证据，而保留 child working，后续再接收真实完成。[回归解释与断言](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/codex/codex-structured-journal-translation-subagents.test.ts#L125-L165)

另一条直接回答用户“用户反馈还是精心设计”的证据：live CLI test 注释说明此前 fixture 虚构了 CLI 不发送的 effortLevel，导致所有门禁都没拦住空白 UI；于是新增真实 binary 检查 get_settings 与 init 的实际区别。这说明回归经验和设计思考共同作用，mock 的自洽并不保证 native fidelity。[具体记录](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/src/main/claude/claude-structured-real-cli.test.ts#L146-L150)

**CI 限定。** PR 按 code-path 调用 8-shard unit workflow；unit include 有上述契约/adapter/SDK/进程测试，部分 shell/platform tests 有显式排除，另有产品/SSH/跨平台 E2E workflows。Claude live test 可被默认 unit glob 选到，但 binary/auth 不可用时 skip，因此不能仅凭 test 文件存在宣称默认 CI 有全 provider 真 agent 保障。本次未发现全体 TUI agents 参数化实现同一结构化行为 suite 的证据。[PR入口](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/.github/workflows/pr.yml#L579-L587)、[unit workflow](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/.github/workflows/unit-tests.yml#L15-L60)、[unit选取](https://github.com/stablyai/orca/blob/1a8640adb6e86abb342a8025892300b2835f3e8e/config/vitest.config.ts#L16-L43)

**对 OAR 的含义。**

- 强反证：session 身份、确定/不确定投递、ownership fencing、cursor、背压并非无人认真解决；Orca 部分语义比 OAR 已交付 v1 更丰富。不能靠“从第一性原理出发”推导 OAR 自然更好。
- 高借鉴价值：把故障例子提炼成可移植不变量和测试场景；特别是 unknown != rejected、进程存活 != transport connected、父 turn end != child end、取消只作用于被请求的 turn、SDK 与 scripted process 的兼容性 pins。
- 公共库空间：Orca 的接口绑定 workspaceId、hostId、provider-handle、lease/journal、TUI/native handoff 和产品恢复；第三方采用需要剥离这些宿主政策。OAR 可抽取 runtime 能真实保证的部分，其余交给宿主组合。
- 不适合承诺替代全部工作台基础设施：PTY multiplexer、屏幕/标题识别、SSH daemon、任务 mailbox、worktree/user UI 行为仍需由不同产品自己处理。若 OAR 宣称承担全部“统一调度”，范围将显著失控。

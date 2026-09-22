# T3 Code：event-sourced 宿主、双层 provider 契约与 OAR 判断

调研版本：`b5a0f810108d42ca8635b5a3d75a6e885bb3a254`（main，2026-09-21）。只读源码、内部文档和 CI 配置，没有安装依赖、运行测试或启动真实 provider。以下链接固定到该 SHA。调研日期 2026-09-22。

## 结论

T3 Code 是 T3 Tools 的 "agent harness control surface"：一个服务端进程控制本机的 Claude Code、Codex、Cursor、Grok、OpenCode、Antigravity，Web、Electron 桌面、Expo 移动端通过 RPC 远程操控。MIT 协议，提交频繁，README 明确"基本不接受贡献"。它是 OAR 想服务的那类消费者的完整产品，而不是可复用的接入库：Effect 全栈、契约与应用层绑死、TypeScript 约百万行。

它值得记录的是三件事：

- **provider 契约分成两层**：一个约十个方法的 `ProviderAdapter` 接口，和一份归一化的 `ProviderRuntimeEvent` 事件词汇，每条事件带可选的原生透传 `raw`。这与 OAR "lossless producer + 语义化消费面"的立场平行，其 item / request / stream 分类是跑过六个 runtime 后沉淀的，适合做 OAR 记录词汇的交叉检查。
- **宿主编排是纯 event sourcing**：command → 纯函数 decider → events，事件、投影、command receipt 在同一 SQLite 事务提交，副作用由 reactor 事后执行。流式增量也作为事件落库，靠合并器、流预算和按 turn 分页对冲成本。
- **子代理归属目前折在客户端**，文件头自称 legacy bridge、等服务端投影上线后删除，并列出历史上因此踩的 bug。这为 OAR "投影归库不归客户端"的立场提供了反面证据。

不能从代码规模或提交频率推断稳定性和用户规模；本次没有运行任何东西。

## 1. 项目定位与规模

| 项 | 值 |
|---|---|
| 提交 | `b5a0f81`，2026-09-21 |
| 文件数 | 约 23k |
| TS 行数 | 服务端 385k，Web 314k，移动端 137k，contracts 27k，client-runtime 59k |
| 核心依赖 | Effect（Schema / Layer / Stream / Queue 全面使用）、React 19、TanStack Router、zustand、tiptap、Expo、`node:sqlite`、Vite+ |
| 接入方式 | Claude：`@anthropic-ai/claude-agent-sdk` 的 `query()`；Codex：自研 `effect-codex-app-server`（app-server JSON-RPC）；OpenCode：官方 SDK；Cursor / Grok / Antigravity：ACP（自研 `effect-acp`） |

架构文档 [`docs/internals/overview.md`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/overview.md) 的第一原则是执行留在拥有 workspace 的环境里：provider 进程、terminal、git、文件都属于服务端，远程客户端不能用自己的文件系统或凭证替代。

## 2. 接入层与宿主编排的边界

### 2.1 `ProviderAdapter`：窄接口，小能力声明

[`ProviderAdapter.ts:67-158`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Services/ProviderAdapter.ts#L67-L158) 定义 startSession / sendTurn / interruptTurn / respondToRequest / respondToUserInput / stopSession / readThread / rollbackThread / listSessions / stopAll，以及 `streamEvents: Stream<ProviderRuntimeEvent>`。compaction 是可选项，分 native 和 slash-command 两种（[`31-43`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Services/ProviderAdapter.ts#L31-L43)）。

能力声明只有三项（[`46-56`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Services/ProviderAdapter.ts#L46-L56)）：能否会话内切模型、能否无合成提示续跑、能否回滚对话。各 adapter 的声明：Claude 只声明切模型，compaction 走 `/compact` 命令（[`ClaudeAdapter.ts:5570-5573`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5570-L5573)）；Codex 额外声明 promptlessTurnContinuation（[`CodexAdapter.ts:2723-2726`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/CodexAdapter.ts#L2723-L2726)）；Cursor、Grok、Antigravity 三个 ACP adapter 都声明不能回滚对话（[`CursorAdapter.ts:1273`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/CursorAdapter.ts#L1273)、[`GrokAdapter.ts:2191`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/GrokAdapter.ts#L2191)、[`AntigravityAdapter.ts:1250`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/AntigravityAdapter.ts#L1250)）。

这个声明集很小，但每一项都有消费者：checkpoint revert 在动文件之前先看 supportsConversationRollback，不能回滚就拒绝（[`overview.md:72-82`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/overview.md#L72-L82)）。[`providers.md:79-94`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/providers.md#L79-L94) 明说"capabilities 必须描述 provider 实际能做的事"。

### 2.2 `ProviderRuntimeEvent`：归一化词汇加原生透传

[`providerRuntime.ts`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts)（1234 行）是 adapter 与编排之间的唯一事件契约。

- 事件类型分组：session.* / thread.* / turn.* / item.started|updated|completed / content.delta / request.opened|resolved / user-input.requested|resolved / task.* / hook.* / tool.progress|summary，以及 auth、account、mcp、model.rerouted、config.warning、deprecation.notice、files.persisted、tool.denied、runtime.warning|error 等旁路事件（[`152-204`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L152-L204)）。
- 每条事件的基座带 threadId、可选 turnId / itemId / requestId、`providerRefs`（原生 turn / item / request id）和可选 `raw: {source, method, messageType, payload}`（[`206-217`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L206-L217)）。`raw.source` 是封闭枚举：codex app-server notification / request、codex eventmsg、claude sdk message / permission、opencode sdk event、acp jsonrpc 及 `acp.<vendor>.extension`（[`24-43`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L24-L43)）。
- item 分类：user_message、assistant_message、reasoning、plan、command_execution、file_change、mcp_tool_call、dynamic_tool_call、collab_agent_tool_call、web_search、image_view、review_entered|exited、context_compaction、error、unknown（[`123-135`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L123-L135)）。
- request 分类：command_execution / file_read / file_change / apply_patch / exec_command / mcp_elicitation / permission 七种 approval，加 tool_user_input、dynamic_tool_call、auth_tokens_refresh、unknown（[`137-150`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L137-L150)）。
- content.delta 带 streamKind：assistant_text、reasoning_text、reasoning_summary_text、plan_text、command_output、file_change_output、unknown（[`84-92`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L84-L92)）。

判断：这是"归一化事件加原生 envelope"的同一形态，和 OAR 记录流一致。区别在于它是 adapter 到编排的内部契约，编排层会把它再翻译成自己的 `thread.*` 事件；OAR 的记录流直接面向消费者。

### 2.3 宿主编排：command → decider → events，一事务提交

[`overview.md:53-70`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/overview.md#L53-L70) 规定：事件日志是编排状态的唯一真相；decider 纯函数产出事件、不做 provider 或文件系统工作；事件、持久化投影和 command receipt 在一个数据库事务里提交；reactor 在意图记录之后做副作用，再通过 command 回灌。"command 被接受"只表示意图已提交，不表示 provider 或 checkpoint 完成。

代码对应：[`OrchestrationEngine.ts:273-330`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L273-L330) 的 `withTransaction`，提交后才更新内存读模型并发布事件。持久化用 `node:sqlite`，[`persistence/Migrations`](https://github.com/pingdotgg/t3code/tree/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/persistence/Migrations) 下 70 个迁移，事件表与投影表（threads、turns、messages、activities、pending approvals、sessions）分开。

编排事件词汇（[`orchestration.ts:1675`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/orchestration.ts#L1675) 起）包含 project / thread 生命周期、turn-start-requested / turn-interrupt-requested、approval-response-requested、user-input-response-requested、message-sent、activity-appended、checkpoint-revert-requested、turn-diff-completed、settled / snoozed / pinned、pull-request-linked 等。thread、turn、checkpoint、PR 链接、pin、snooze 全部进同一个事件日志。这正是 OAR 文档所称的"应用数据所有权"层：T3 把它和 provider 事实混在一个 store 里，OAR 选择把它留给应用。

## 3. session、turn、event、native identity 与 child 关系

### 3.1 session 与 resume cursor

thread 是持久对话，session 是挂在 thread 上的 provider 运行时，可停可续（glossary）。每个 thread 一行 `ProviderSessionRuntime`，其中 `resumeCursor` 是 provider 自定义的 JSON（[`ProviderSessionRuntime.ts:51`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/persistence/ProviderSessionRuntime.ts#L51)）。Claude 的 cursor 是 `{threadId, resume, resumeSessionAt, turnCount}`（[`ClaudeAdapter.ts:969-1006`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.ts#L969-L1006)），启动 `query()` 时带 resume、`includePartialMessages: true`、`canUseTool`、`settingSources`、`supportedDialogKinds: ["resume_return"]`（[`4913-4949`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4913-L4949)）。

T3 还能把 `~/.claude` 和 Codex 的原生会话文件扫描导入成 thread（[`agentSessions.ts`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/agentSessions.ts#L1-L25)，命令 `thread.history.import`），导入的 message id 用 `import:` 前缀保留来源，decider 拒绝 live 命令使用该命名空间（[`decider.ts:1917-1921`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/orchestration/decider.ts#L1917-L1921)）。

### 3.2 turn 与 item

turn 由宿主发号（turnId），provider 的 turn / item / request id 放在 `providerRefs`。turn 结束与后续工作结算是两个里程碑：projector 从 session 状态结算 turn，晚到的 checkpoint 或 diff 不能延长 turn 时长或让客户端继续显示 provider 在工作（[`overview.md:72-82`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/overview.md#L72-L82)）。glossary 里 "quiesced" 专指后续 worker 也完成，区别于 turn 结束。

### 3.3 子代理：扁平归属，客户端折叠

`ItemLifecyclePayload` 只带 `agentId` 和 `parentToolUseId`，注释说客户端把这些 item 从主时间线"re-home"到 Agents 面板（[`providerRuntime.ts:432-449`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L432-L449)）。task.* 事件承载 Claude SDK 的 task_started / task_progress / task_notification（[`ClaudeAdapter.ts:3707-3874`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3707-L3874)）。

子代理状态的 fold 在客户端：[`subagentRuntime.ts:1-20`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/client-runtime/src/state/subagentRuntime.ts#L1-L20)（892 行）自称 "deliberately legacy-bridge code"，等 orchestration-v2 的服务端子代理投影上线就删除，并列出三个 PR 修过的不变量：可复用身份 vs 一次性激活、idle 是真实非终态、provider 各异的 usage 合并、终态时间戳首写生效、重新激活清除终态细节、乱序鲁棒（completion 可以创建 agent，晚到的 start 只补元数据）。usage 合并的 provider 差异也写在契约注释里：Claude 报每次激活的增量，Codex 报累计（[`providerRuntime.ts:505-520`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L505-L520)）。

判断：T3 用一年时间证明了"子代理 fold 放客户端"要付的代价，正在迁回服务端。

## 4. 取消、恢复、steer 与权限

### 4.1 steer 是 adapter 的隐含行为，queue 是客户端的定时策略

编排契约里没有 steer 动词，只有 `thread.turn.start` 和 `thread.turn.interrupt`（[`orchestration.ts:1306-1352`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/orchestration.ts#L1306-L1352)）。语义分散在两端：

- Claude adapter 的 sendTurn 在真实 turn 运行中就是 steer：消息进入 SDK 的流式输入队列，作为同一个 turn 继续，"no synthetic turn boundary"；后台 agent 响应产生的合成 turn 则被自动关闭以免阻塞（[`ClaudeAdapter.ts:5153-5160`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5153-L5160)、[`5262-5276`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5262-L5276)）。Codex 的 sendTurn 总是 `turn/start`，排队交给 app-server（[`CodexAdapter.ts:2517-2545`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/CodexAdapter.ts#L2517-L2545)）。
- Web / 桌面客户端默认 Queue：运行中发送的消息以虚线气泡挂在对话末尾，等下一次 tool call 结束或 turn 结束时再发；设置改成 Steer 则立即发（[`docs/user/composer.md:36-51`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/user/composer.md#L36-L51)，[`queuedMessageStore.ts:1-25`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/web/src/queuedMessageStore.ts#L1-L25) 用 `queuedAfterToolActivityId` 判定边界）。
- 服务端只在 compaction 期间维护一个 turn 队列（[`ProviderCommandReactor.ts:253-262`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L253-L262)）。

判断：投递结果（这条消息是 steer 进了当前 turn，还是开了新 turn）没有作为事实回读给客户端，客户端靠自己的定时策略推断。OAR 的 steer / queue / rejected 投递语义在这里更细。

### 4.2 权限与用户输入分两类请求

approval 走 request.opened / resolved，user input 走 user-input.requested / resolved，adapter 分别有 respondToRequest 和 respondToUserInput。`UserInputQuestion` 有 id、header、question、options（label / description / value）、allowCustomAnswer、multiSelect（[`providerRuntime.ts:482-498`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/providerRuntime.ts#L482-L498)）。

[`providers.md:79-94`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/providers.md#L79-L94) 记录的 protocol trap：Codex 的异步提问以 notification 到达、用新 user message 回答，没有待回的 RPC；阻塞式提问仍走 request / response。adapter 用 `responseMode: "message"` 区分（[`CodexAdapter.ts:1685-1705`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/CodexAdapter.ts#L1685-L1705)）。异步提问可以跨 turn 甚至跨服务端重启存活，engine 解决它之前要读持久化的 activity，不能因为它不在近期窗口里就当它消失。

原生 permission / question 的 option id 必须在归一化后保留，"display label 不一定是合法回复"。

### 4.3 附件

附件存在 workspace 之外，turn input 只带环境本地路径，adapter 选原生输入格式；"路径出现在 prompt 里不授予文件访问权"，不得把上传复制进项目绕过 sandbox（[`providers.md:96-108`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/providers.md#L96-L108)）。同一节记录了 file 附件引入的 replay 兼容性问题：只认 image 的旧服务端 replay 到 file 事件会让整个环境启动失败。

## 5. 持久化、replay 与 live 流

- **增量落库**：`thread.message.assistant.delta` / `reasoning.delta` 命令各产生一条 `thread.message-sent`（`streaming: true`）事件（[`decider.ts:1915-1947`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/orchestration/decider.ts#L1915-L1947)）。
- **对冲成本**：live 事件 50ms 窗口合并（[`ThreadLiveEventCoalescer.ts:18-19`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/orchestration/ThreadLiveEventCoalescer.ts#L18-L19)）；每个订阅 1000 条 / 8MB 预算，超出即失败并要求重新快照（[`LiveStreamBudget.ts:9-10`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/orchestration/LiveStreamBudget.ts#L9-L10)）；thread detail 按 turn 分页，页元数据带 per-thread sequence 水位，客户端必须先应用到该水位的 live 事件再合并历史页，否则 delta 会重复叠加（[`orchestration.ts:1040-1078`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/packages/contracts/src/orchestration.ts#L1040-L1078)）。
- **replay 兼容性是一等约束**：持久化事件必须在 replay 时可解码；schema 变更影响旧环境启动，不只是 live RPC（[`overview.md:66-70`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/overview.md#L66-L70)）。
- **旁路观测日志**：每个 thread 三路 NDJSON（native / canonical / orchestration），轮转、限额、按天保留，瞬态 delta 类事件默认过滤（[`EventNdjsonLogger.ts:42-64`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/EventNdjsonLogger.ts#L42-L64)）。
- **客户端缓存**：离线可读缓存投影，但不能暗示连接存活或覆盖更新的 live 数据；thread detail 订阅生命周期与缓存生命周期分离，空闲缓存保留五分钟（[`connection-runtime.md`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/connection-runtime.md)）。

## 6. 测试替换边界与 CI

- Claude adapter 测试用 `FakeClaudeQuery` 在 SDK `SDKMessage` 层替换（[`ClaudeAdapter.test.ts:61-130`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L61-L130)，全文件 8239 行），真实 adapter 逻辑跑在 fake 消息流上。Codex adapter 测试 3085 行，同类形态。
- 编排层有 drainable worker 和 test-only runtime receipt 等专门的等待原语；生产实现是 no-op，生产行为必须用持久化状态和事件（[`overview.md:84-92`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/docs/internals/overview.md#L84-L92)）。
- CI（[`ci.yml:115-153`](https://github.com/pingdotgg/t3code/blob/b5a0f810108d42ca8635b5a3d75a6e885bb3a254/.github/workflows/ci.yml#L115-L153)）跑全部包的 `vp test`，服务端分片执行，另有 Windows 工作流。没有看到默认 CI 启动真实 provider 二进制的步骤；`CodexCollabRuntime.integration.test.ts` 的 gating 未核实。
- 本次未运行任何测试。

## 7. 对 OAR 的启示、限制与可验证假设

对照 [`chat-ui.md`](../design/chat-ui.md) 的开放问题：

1. **投影归库，不归客户端**（已被 T3 的反面证据支持）。T3 子代理 fold 在客户端造成三轮 bug 后正在迁回服务端投影。OAR 把 `reduceSessionView` 放在库里的立场与之一致。
2. **回答 runtime 请求**（开放问题 2）。T3 把 approval 与 user input 拆成两类请求、两个 respond 方法，且 question 结构带 options / multiSelect / allowCustomAnswer。Codex 异步提问"用新 user message 回答"这一 trap 应进 OAR 的 codex runtime 页面核对。
3. **非文本输入**（开放问题 4）。附件存在 workspace 外、只传环境本地路径、adapter 选原生格式、路径不等于访问授权。这是一个可直接复用的输入模型位置，不是 UI 问题。
4. **fold 在哪跑**（开放问题 5）。T3 的答案是服务端投影加按 turn 分页加 per-thread sequence 水位。若 OAR 的 SessionView 要支持长会话，分页水位是必须解决的同一问题。
5. **OAR 更细的地方**。T3 没有把 steer / queue 的投递结果作为事实回读；`agentPath` 层级归属比它的扁平 `agentId` 表达力强；T3 的 turn 结束与结算分离和 OAR 的 status fold 是同类关切，但 OAR 没有 checkpoint 这层。
6. **词汇交叉检查**。T3 的 item、request、streamKind 三张枚举表值得和 [`record-stream.md`](../spec/record-stream.md) 逐项比对，重点是 context_compaction、review_entered/exited、collab_agent_tool_call、mcp_elicitation_approval、auth_tokens_refresh 这些 OAR 可能尚未命名的事实。

限制：

- T3 不是可依赖的库。契约、编排、UI 同仓同版本，Effect 贯穿到 contracts 包，抽出来的成本高于重写。
- `ProviderAdapter` 是它唯一清晰的接缝。理论上 OAR 可以做成一个 adapter 挂进去，但 README 声明不接受大功能贡献，这条路只作为思想实验。
- 本次没有运行，所有关于稳定性的说法都来自源码注释和文档，不来自观察。

可验证假设：

- Claude 运行中 sendTurn 的 steer 是否真的不产生 turn 边界，可用 OAR 的 `claude-stream-json-input` 探针复现。
- Codex 异步提问是否在 turn 结束后仍能被回答，可用 OAR 的 codex 探针验证。
- 增量落库在长会话下的 SQLite 体积和 replay 时间，未有数据。

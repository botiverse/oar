# One Works：统一 agent 调度/接入层是否已解决，以及对 OAR 的意义

基线：main@`6b5f3bbc785539e7fe208f3501e332e1a7c19709`，2026-08-30；调研日期 2026-09-08。只读浅克隆/源码检查，未安装依赖或运行测试。下文“测试覆盖”指已写的测试与入口，不代表本次运行通过。测试/CI由 paseo agent 独立核对。

## 判断先行

**One Works 是对“还没有人把统一 adapter 和确定性 agent 测试做好”的直接反证。** 它不只是桌面 UI：已有独立 adapter npm packages、统一 runtime-protocol/runtime-store、CLI 协议供 server/UI/agent 共用，以及四家真实 CLI/wrapper 接本地 mock LLM 的共享 E2E harness。OAR 若仅主张“统一 query 接口、接多个 CLI、可 mock LLM 测试”，独特性不足。[动态 package adapter 加载](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter-package.ts#L453-L462)；[统一协议](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-protocol/src/types.ts#L31-L92)；[真实 runtime + mock LLM harness](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/adapter-e2e/harness.ts#L25-L60)。

但它并未把所有 runtime 变成可自由互换、具有同一 lifecycle/identity/failure 保证的对象。它更重“统一 workspace/config/assets + 多入口工作台”，核心 AdapterSession 较薄，native turn/子 agent/raw 语义没有统一保真；部分持久化故障的实际语义也弱于 Synara。这里留下的是可检验的契约与复用成本问题，不是“它没跑全部 live 所以不可靠”。

## 一、接入抽象与可复用程度

### Adapter 比 Synara 小，但 package 层更开放

`Adapter.query(ctx, options): Promise<AdapterSession>` 是唯一必需入口；init/accounts/usage/shared model bridge 等可选。options 有 create/resume、sessionId、model/account/effort/fastMode、stream/direct、systemPrompt、permissionMode、skills/tools/MCP selection、assetPlan、onEvent。返回 session 只有 kill、可选 stop、emit(message|interrupt|stop)、可选 respondInteraction/flushHooks、pid；方法多为 void/fire-and-forget，没有统一 Promise cancellation completion、fork/rollback/steer capability 协商。init 回报 `sessionRecovery: native-resume | live-only` 是有价值的语义区分。[query/session](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter.ts#L264-L307)；[adapter shape](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter.ts#L336-L374)；[recovery declaration](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter.ts#L96-L112)。

`defineAdapter` 只是 TS identity helper；`loadAdapter` 读取 default export 后 cast，未见 Synara 那种核心 required-method/capability→method 注册检查。但扩展 capability（如 package 的 import/export）另有专门 validation，不应概括为“完全没有运行时校验”。核心 interface 没有统一大 capability object，能力分散于 optional methods、model metadata、session init recovery、workspace asset planner。[defineAdapter](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter.ts#L374)；[核心加载边界](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter-package.ts#L453-L462)；[package capability 验证测试](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/__tests__/adapter.spec.ts#L316)。

adapter 不是 Synara 静态九服务 registry：`resolveAdapterRuntimeTarget` 区分 instanceKey、loadSpecifier、runtimeAdapter、packageId，能指定 package 或本地路径，从 workspace/全局缓存/runtime package 等解析模块。16 个 adapter packages 各自持有 native config、CLI prepare、runtime mapper 等；这个 package 分离本身已经具备减少后续接入应用重复工作的方向。[instance 与实现 package 分离](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter-package.ts#L318-L356)；[路径/包加载](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter-package.ts#L437-L462)；[adapter packages](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/package.json#L48-L63)。

### 它真正统一的是“工作区资产投影”

prepare→selection→adapter init→query 的流程将统一规则、skills、MCP、hooks 投影到各 CLI 的 native/mock home/session config。资产计划不仅给 boolean supported，而是输出 `native | translated | prompt | skipped` 加 reason/source，避免把“接受配置”当成“能力可用”。

例如代码明确声明 Cline 3.0.54 ACP 接受 MCP descriptor 但没有观察到连接，选择 skipped；Pi 无稳定内建 MCP 映射不擅自加载第三方扩展；Kiro 只传 stdio；Goose 跳过 SSE。对 OAR 的直接借鉴是 **capability 包含支持方式、限制和证据粒度**，不止 supportsX。[能力与可观察降级](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/workspace-assets/src/adapter-asset-plan.ts#L61-L107)；[native hook vs event bridge](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/workspace-assets/src/adapter-asset-plan.ts#L109-L135)。

这也说明两面性：有意设计的 planner 能容纳差异，但 planner 内仍有按 provider/版本的分支；adapter 各自拥有大量环境、认证、配置补丁。统一层没有消灭维护原生差异的工作，只是给它一个归属。

## 二、调度与运行协议：实现在哪一层

### File runtime store 是实际公共集成面

`@oneworks/runtime-protocol` 定义 versioned commands/results/events；correlation 包含 commandId、causedByCommandId、inReplyToCommandId、parentEventId、runId、operationId、roomId、memberKey、visibility。RuntimeEvent 用 per-session id/seq/ts，可从 afterSeq 重放。版本 helper 实际支持 semver caret/exact/通配。[协议与因果字段](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-protocol/src/types.ts#L31-L92)；[event schema](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-protocol/src/types.ts#L174-L224)；[兼容检查实现](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-protocol/src/version.ts#L89-L124)。

`FileRuntimeSessionStore` 写 meta/state/heartbeat、append commands/events JSONL，append/write 各自有 lock，snapshot 用 atomic JSON write，runtime owner lock 30s stale policy。每次 appendEvent 持 append lock 后 replay 现有 events 获取 lastSeq；可以保证此实现中多写者分配次序，但从源码看 append 成本随历史增长，不能在未测量时推断吞吐表现。[store/append/owner](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-store/src/session-store.ts#L44-L123)。

stop/kill/cancel/pause 为 lifecycle priority 0，approval/input 为 10，message 为 20；运行中 lifecycle 能越过普通队列。[command priority](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-store/src/scheduler.ts#L3-L60)。

**不要把 draft RFC 或抽象类当实际落点。** RFC0004明确提出将 task runtime 从 MCP 内存对象移到文件协议；这部分已有上述代码。可是 `TaskRuntimeEngine` 仍是独立 abstract class，仓库非测试代码未找到继承/实例使用；实际工作路径在 CLI protocol → runtime files → server engine-consumer/CLI runtime-command-bridge。因此不能说所有实现都经该 abstract class。[draft 状态](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/.oo/rfcs/0004-cli-runtime-protocol.md#L1-L9)；[设计 rationale](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/.oo/rfcs/0004-cli-runtime-protocol.md#L46-L83)；[abstract class](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/task-runtime/src/engine.ts#L20-L43)；[实际 dispatch/ack](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/apps/cli/src/commands/run/runtime-command-bridge.ts#L85-L142)。

server engine-consumer 根据 metadata/heartbeat/PID/queued command 决定启动或恢复；`live-only` 的仍存活 runtime 不重复启动，断连后不假装支持持久 resume，而写失败让用户新建 session。[live-only 存活检查](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/apps/server/src/services/runtime-store/engine-consumer.ts#L383-L405)；[不可 resume 的明确拒绝](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/apps/server/src/services/runtime-store/engine-consumer.ts#L849-L873)。

### 宿主多 agent 已实现，但不是 provider-native 子 agent 全部统一

agent 的默认 guidance 明确使用 CLI JSONL `session.start/message/status/events/submit/stop`，不走 MCP task tools；可用多行 start 运行多个 child，继承或覆盖 adapter/model。createRuntimeSession 实际写 parentSessionId/hostSessionId/roomId/member/run/operation metadata + start command；server 将这些投影为 Agent Room。Synara 用 MCP host 工具，One Works 选择 CLI/store，二者都已有跨 runtime 宿主编排。[agent 操作入口](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/workspace-assets/src/task-tool-guidance.ts#L16-L38)；[child runtime 创建实现](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/apps/cli/src/commands/agent/runtime-store-session.ts#L34-L109)。

此处 room/member/run 是宿主显式启动任务的身份，不应当成 Codex collab/Claude native subagent 通用控制层。检查的 Codex/Claude incoming mapper 与公共 AdapterOutputEvent 未见 Synara 那种 native providerParentThreadId/parent tool归属、child session materialization；Task/Agent tool 可以以工具消息出现，不能据此说 native subagent 完整隔离/可控。[adapter event 边界](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/adapter.ts#L69-L80)；[产品 message identity](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/types/src/message.ts#L98-L123)；[tool 消息映射](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/claude-code/src/protocol/incoming.ts#L169-L186)。

## 三、身份 / raw / 故障语义的边界

### 原生身份内部保留，不是公共事件的完整契约

Codex 用 cache 把 app session 映射到原生 threadId，activeTurnId 在 stream 内跟踪；原生 item ID 可作为 ChatMessage.id、tool_use/tool_result ID。[native thread cache/turn tracking](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/stream.ts#L642-L660)；[native item/tool ID](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/protocol/incoming.ts#L226-L255)。

公共 RuntimeEvent 没有标准 native refs/raw 字段；CLI sink 从 Adapter message 提取 role/content/model/usage，没有复制原 ChatMessage.id，也没有 native turn/session/tool ownership envelope。Codex delta 先在 adapter accumulator 累积，item complete 再发 message。所以这里的 runtime events replay 是**产品投影 replay**，不是完整 native protocol replay。Claude stdout 有 debug logging，不等于统一原生可重投影 archive。[sink 投影](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/apps/cli/src/commands/run/runtime-event-sink.ts#L344-L375)；[delta accumulation](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/protocol/incoming.ts#L144-L155)；[native debug/parse](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/claude-code/src/claude/session.ts#L211-L251)。

### 部分恢复设计精细；但没有统一 journal acceptance 保证

好的例子是 Codex account pool：只允许新 stream session 在首个 assistant/tool/approval/terminal event 提交前换账号；已开始的 session 保持粘性，用 attemptGeneration 丢弃过期尝试事件。这是“不重放可能已产生副作用的 turn”这一明确语义，而非随意重试。[commit point](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/session.ts#L25-L30)；[粘性与failover约束](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/session.ts#L54-L79)；[generation隔离](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/session.ts#L135-L158)。

另一个是 Codex app-server pool：profileKey/lease/按 thread 路由、owner symbol、共享进程最后一个 lease release 后才 idle shutdown；可走 local pool 或 runtime broker。避免将“session close”与“杀共享进程”等同。[pool与lease](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/app-server-pool.ts#L22-L78)；[release隔离](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/app-server-pool.ts#L327-L342)；[local/broker双路径](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/src/runtime/app-server-pool.ts#L567-L573)。

但 CLI `RuntimeEventSink.append` 当前在串行 Promise queue 上写失败后 console.error 并继续，flush 只等 queue，未见 Synara 的当前事件原地重试/quarantine。准确结论是：**此 sink 不提供“收到的每个 terminal event 都可靠落 journal”的保证**，并非“因此产品整体不可靠”。[append failure 语义](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/apps/cli/src/commands/run/runtime-event-sink.ts#L493-L520)。

## 四、测试：它真的与 OAR 重叠，范围也要说准确

### 1. 最有价值的共享 E2E：真 agent runtime，假 LLM

`scripts/adapter-e2e` 起本地 mock LLM server，runner 真 spawn CLI/wrapper；当前 covered adapters 为 codex、claude-code、opencode、pi。mock 服务实现 Responses/Chat Completions，以 deterministic scenario 引导真实 runtime 执行工具/hook。**这不是顶层 fake Adapter，能观察原生 CLI 的实际配置和工具调用。**[mock server与harness](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/adapter-e2e/harness.ts#L25-L60)；[真实 spawn](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/adapter-e2e/runners.ts#L127-L180)；[mock协议入口](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/adapter-e2e/mock-llm/server.ts#L106-L126)。

同一 case DSL / assertion 检查 exit code、允许的 transport、hooks、LLM request trace，normalize 后 stable snapshot。当前 11 cases：四家 read-once/direct-answer，加 Codex apply_patch/两项 transcript injection；强项是 hooks/managed assets 的端到端可观察语义，并非全 provider 的 send/interrupt/resume/fork/permission state-machine contract。[共享case构造](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/cases.ts#L156-L210)；[实际case清单](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/cases.ts#L451-L462)；[公共验收](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/assertions.ts#L80-L91)。

它与 OAR 的 raw fixture/sea-trial mock+live 方法确有重合。OAR若继续，应比较“能验证哪些具体语义”和“差异应用接入后需要改多少”，不要宣称这种测试架构尚无人实现。

### 2. 单 adapter 测试的 seam

- Codex session-rpc tests mock native spawn/hooks，保留真 adapter/runtime mapping。[Codex seam](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/codex/__tests__/session-rpc.spec.ts#L25-L38)。
- Claude session tests mock prepare/accounts/spawn，保留 session 协议逻辑。[Claude seam](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/claude-code/__tests__/session.spec.ts#L11-L29)。
- Goose 使用 fake-goose-acp 真子进程，验证真实 stdio/RPC及跨进程 resume native ID、replay 去重；它是 simulated provider process，而非真 Goose+真LLM。[Goose subprocess seam](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/goose/__tests__/session.spec.ts#L51-L78)；[跨进程resume](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/goose/__tests__/session.spec.ts#L174-L200)。
- runtime protocol 验 roundtrip 保留未知 additive fields；runtime broker 故障注入保证回复可重试而 handler 只调用一次。[协议演进契约](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-protocol/__tests__/runtime-protocol.spec.ts#L49-L63)；[retry/idempotency](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/runtime-broker/__tests__/client.spec.ts#L152-L200)。

### 3. CI 的边界

统一 adapter E2E 默认 skip，需 `ONEWORKS_RUN_ADAPTER_E2E=1`；根 `test:e2e:adapters` 经 tools CLI 打开 gate。完整 workflows 搜索未发现调用该 suite/gate，quality workflow相关 lane 是 lint/format/env/typecheck/build；其它 relay/browser/release tests 不能代表 adapter suite。**存在可运行的强 harness，与默认 CI 自动持续验证它，是两件事。** 不能从 opt-in 推导项目不可靠，也不能从有脚本推导已在所有版本验证。[默认gate](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/__tests__/adapter-e2e/adapter-e2e.spec.ts#L7-L8)；[wrapper开启gate](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/scripts/cli.ts#L72-L95)；[quality实际命令](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/.github/workflows/quality.yml#L392-L422)。

## 五、精心设计，还是用户迭代？能得出的结论

两者不是互斥。可观察的有意设计包括：RFC明确讨论为什么MCP不应拥有任务状态；配置/资产与session分层；独立 versioned协议；unknown additive字段 roundtrip；真实runtime+mock LLM统一验收；账号 failover commit point；共享进程 lease。可观察的兼容经验包括：特定CLI版本能力不兑现时skip、missing conversation受控fallback、provider-specific home/hooks/认证差异。这些都在代码中，而非只在 README。[架构理由](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/.oo/rfcs/0004-cli-runtime-protocol.md#L46-L83)；[实测差异](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/workspace-assets/src/adapter-asset-plan.ts#L90-L105)；[missing-conversation fallback window](https://github.com/oneworks-ai/app/blob/6b5f3bbc785539e7fe208f3501e332e1a7c19709/packages/adapters/claude-code/src/claude/session.ts#L223-L240)。

**无法仅凭源码推导“靠多少真实用户打磨出来”，或证明其实际运行可靠率。** 不应拿 stars、test数量、文档篇幅替代部署数据、故障率和真实使用反馈。更合理的评价是：它已经形成有意识的统一层，而且同样受 native runtime 差异维护约束。

## 六、对 OAR 的具体意义（推论）

1. **应承认已解决的部分**：多 adapter packaging、统一运行入口、workspace assets translation、deterministic native-runtime tests，One Works均不是空白；它甚至已有独立 packages，不能简单说工作台代码“无法复用”。
2. **OAR仍可成立的目标**：更窄、与产品UI/config无关的runtime/session契约；明确 native/app ID与child归属；raw trace保真与独立投影；cancel/approval/resume/断连/重复事件的跨provider行为矩阵。它的价值可以就是让后来差异化产品少重复这些工作，但必须用真实下游接入检验。
3. **不建议以接口优雅作为竞争证据**：应选两个不同应用接同一OAR版本，统计其provider-specific分支和新增代码，验证升级CLI时是修OAR一次还是每个应用都要改；再与直接用One Works adapter packages或抽取其runtime协议比较。
4. **最值得抄的是验收而非框架**：把四家真CLI+mock模型的case设计、原生hook/skill命中证据、明确支持方式、commit-point failover、shared-process lease纳入OAR；同时保持现有raw replay与sea-trial对session语义的验证，不把hook测试当作完整行为契约。


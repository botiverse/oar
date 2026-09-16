# 调研项目功能对照

按具体功能横向汇总 Paseo、Lody、Synara、One Works、Orca、Herdr、Multica。这里比较的是宿主项目的接入与运行机制，不是 Codex、Claude 等原生 runtime 的能力。

整理日期：2026-09-16。依据已有 findings 的固定源码版本、测试代码和 CI 配置；本次未新增源码或运行验证。表中的接口存在不意味着所有 provider 都实现同一语义；“未核实”表示现有调研不足，不表示没有能力。各行项目链接是该行的详细证据入口。表后的总结与 OAR 含义是基于这些证据的分析判断，不代表新增设计决策或已实现承诺。

## 接入、能力与输入控制

| 项目 / 证据 | 接入抽象与扩展 | 能力声明 | 输入、steer 与取消 | 权限交互 |
|---|---|---|---|---|
| [Paseo](paseo-findings.md#1-抽象层值得关注的是生命周期契约而不只是-adapter) | AgentClient + 持久 AgentSession；direct SDK / app-server 与共享 ACP；custom provider | capabilities、UI features、strict provider options 分开 | startTurn；可选 steer；interrupt 成功要求旧 foreground turn 已不能继续运行 | Session permissions；provider registry 映射 tool policy |
| [Lody](lody-findings.md#1-接入抽象层) | Launch → 共享 ACP Client → 产品会话；原生适配在子模块 | 标准 ACP + 版本化扩展；steer 区分 same/handoff、active/apply | prompt/cancel；按协商选择 steer transport；持久 user-turn 驱动执行 | ACP 权限、文件和 terminal 请求由宿主处理 |
| [Synara](synara-findings.md#接入抽象) | 静态 ProviderAdapter registry；原生接口与共享 ACP 并存 | 注册时核验方法；model switch 区分 in-session/restart-session/unsupported | send/interrupt；steer 可选；gateway 默认 queue，不支持 steer 时排队 | approval/user-input response 是 adapter 契约 |
| [One Works](oneworks-findings.md#一接入抽象与可复用程度) | query → AdapterSession；支持 package / 本地路径加载 | optional methods + recovery 声明 + 资产计划 native/translated/prompt/skipped | emit message/interrupt/stop、kill；多为 fire-and-forget，非统一取消完成承诺 | respondInteraction 可选；配置可带 permissionMode |
| [Orca](orca-findings.md) | TUI/PTY 与较窄结构化 session 并存；结构化路线有 adapter router | 能力受路线与 provider 限制，不能把全部 TUI agent 算作结构化接入 | acquire/dispatch/cancelTurn/close；mutation 带 operation ID、fence、fingerprint | 结构化 answerPrompt；原生 TUI 另有交互边界 |
| [Herdr](herdr-findings.md#实际统一了什么) | server 拥有原生终端；socket / CLI 控制 pane 中的 agent | hook/plugin 或屏幕规则依 agent 而异 | prompt/send_keys；PTY 写完不等于 native turn 接受；wait 先等 activity 再等稳定状态 | 保留原生权限 UI；blocked 状态来自 hook 或屏幕检测 |
| [Multica](multica-findings.md#抽象层它统一了什么) | Backend.Execute → Messages + Result；runtime identity 与 protocol family 分离 | family 白名单、override 校验；部分不支持参数被忽略 | Go context 取消；Messages 先关、Result 恰好一次；无持久 Session steer 接口 | ACP 默认选择允许选项，非公开交互式权限响应 API |

**总结与 OAR 含义。** 统一接入已是多个项目的基础能力，差异更多体现在操作成功究竟证明什么、可选能力如何降级。Lody 对 steer 的细分、Paseo 对 interrupt 完成的定义，都比一个 supportsX 更能帮助调用者决策。OAR 的价值需要落在可独立复用的行为契约上：说清输入何时被接受、取消何时结束，以及不支持时谁持有输入和决定重试；provider 数量和统一方法名本身不足以证明增量价值。

## 会话历史与恢复

| 项目 / 证据 | 宿主保存什么 | 原生历史 / resume 接入 | replay 与恢复限制 |
|---|---|---|---|
| [Paseo](paseo-findings.md#1-抽象层值得关注的是生命周期契约而不只是-adapter) | canonical timeline items、应用与 provider 消息身份 | import/list native sessions、streamHistory；只读 `resumeSession(..., { purpose: "history" })`；native history 由 adapter 恢复 | close 只释放 live runtime；archive 与 history resume 分开，防止读历史反向激活 agent |
| [Lody](lody-findings.md#1-接入抽象层) | Loro / SessionDocument 的产品历史 | ACP new/load/resume/fork 按能力与 SDK 方法选择；缺少 resume/fork 明确报错 | 历史会 compact/sanitize；不等同 raw 协议日志；旧 ACP session 通知被隔离 |
| [Synara](synara-findings.md#2-session-生命周期是持久化状态机不只是-mapidsession) | canonical journal；session directory 保存 generation、resumeCursor、runtimePayload 等 | adapter 有 start/resume、read/rollback，可选 native fork；各 provider 具体读回路径未逐一核实 | canonical 先 journal、再更新 binding、再 publish；native resumeCursor 保持 unknown，不强行统一形状 |
| [One Works](oneworks-findings.md#file-runtime-store-是实际公共集成面) | per-session commands/events JSONL，meta/state/heartbeat | init 声明 native-resume 或 live-only；consumer 按 metadata / heartbeat / PID 决定恢复 | RuntimeEvent 可 afterSeq 重放；live-only 断连不可恢复时明确失败；这是产品投影 replay |
| [Orca](orca-findings.md) | 产品 wire history、reduced state | 结构化 session 恢复涉及 lease、journal、native/TUI handoff；不能概括为一个 resume 方法 | epoch/cursor、tail/before/after、reset/tombstones；增量重复应用收敛；非全量 native event 日志 |
| [Herdr](herdr-findings.md#状态sessionsubagentraw-的边界) | 工作区/终端状态与 native session 的 id/path 引用 | 重启转为 claude --resume、codex resume、pi --session 等；不导入统一 conversation history | TUI 断开后 server 可继续拥有进程；冷重启是另一种恢复；EventHub 仅内存最多 512 条 |
| [Multica](multica-findings.md#补充会话持久化与-replay2026-09-15基线-a843b44a) | task_message 行；native session ID 与 work_dir 另存 | 下次 Execute 传 ResumeSessionID；运行中 pin native ID；所调研 transcript 路径不读 vendor 历史 | 冷加载与增量消息共用 buildTimeline；seq 为 daemon 进程内计数器；ResumeRejected 要求正证据 |

**总结与 OAR 含义。** 宿主展示历史、原生上下文恢复、运行中的重新附着是不同需求，自存 transcript 与原生历史读取也可以并存，Paseo 是明确例子。OAR 应让调用者分清 resume 恢复了什么、原有观察 cursor 是否仍有效，以及恢复失败是否有明确证据；展示历史的存储与裁剪仍可由宿主选择。是否增加 readback 应由导入外部会话等具体需求推动，不能用“宿主都不读原生历史”作为拒绝理由；现有取舍与重议条件见[设计决策](../design/decisions.md#session-history-readback-2026-09-15)。

## 事件保真、身份与多 agent

| 项目 / 证据 | 事件 / raw 保留边界 | 原生子 agent | 宿主创建的独立 agent |
|---|---|---|---|
| [Paseo](paseo-findings.md#2-事件和身份统一投影但保留必要的-native-identity) | 语义流与 timeline；没有必须保留 native envelope 的字段；clientMessageId / providerMessageId 分离 | provider_subagent + 独立 store，parent/native child 复合键，保留嵌套与 tool 关联；通常只读 | create_agent / send_agent_prompt；后台完成通知；与 native child 分开 |
| [Lody](lody-findings.md#id事件和-raw-保真) | host / ACP session ID 分离；历史默认剥离通用 rawInput/rawOutput，terminal 输出有界 | `_meta.lody.task` → subagent_task，保留 task/parent/tool ID；未广告 AIR，不能宣称完整 child transcript 接入 | MCP create/chat 批量操作；独立 session、parentSessionId、完成 continuation |
| [Synara](synara-findings.md#3-canonical-与原生身份并存raw-有限保留) | canonical IDs + providerRefs + raw/unmapped；raw 超预算可截断 | materialize child thread；Claude 识别 Task/Agent 后建立上下文，避免把 async Bash 当子 agent | MCP gateway 创建独立线程 / worktree；requestId 幂等；queue/steer |
| [One Works](oneworks-findings.md#三身份--raw--故障语义的边界) | 公共 RuntimeEvent 无标准 native refs/raw；sink 投影并可能丢弃原消息 ID；Codex delta 先累积 | 已查 mapper 未见完整 parent/child materialization；工具消息不等于独立 child | CLI JSONL + runtime store 创建 child，带 parent/host/room/member/run/operation 身份 |
| [Orca](orca-findings.md) | wire history 服务产品投影和跨客户端同步，不承诺全部 native 消息保真 | 结构化子 agent 独立收尾；父 turn 结束不能宣告 child 已结束 | Run/Task/Dispatch/Delivery、mailbox、consumer generation 与 decision gate |
| [Herdr](herdr-findings.md#状态sessionsubagentraw-的边界) | 屏幕/scrollback 与工作台事件；非原生 JSON 逐条透传 | OpenCode root/child 权限状态上卷到正确 pane；无公共统一 child transcript / graph | 可脚本组合 start/prompt/wait；不是内置持久任务队列 / DAG |
| [Multica](multica-findings.md#4-多-agent-编排属于任务产品native-child-不是此接口的一等对象) | Message 有 CallID/SessionID，无 raw envelope/native turn/parent-child 契约 | Codex 路径过滤其他/native child thread，保护 root 终态；不输出完整 child topology | DB/coordinator/issue/squad/priority 等产品实体承担委派与恢复 |

**总结与 OAR 含义。** 各项目按产品需要保留事件和身份，因此有损历史不等于适配不认真；原生 child 与宿主独立任务也普遍需要分开处理。OAR 的可复用空间在于保留所选接口实际给出的原始记录、身份与父子关系，让宿主能够重新投影，并明确接口本身不可见的部分。任务分配、mailbox 和 worktree 生命周期属于宿主；可观察到 child 也不意味着拥有它的控制权。

## 故障处理与测试证据

| 项目 / 证据 | 具体故障机制 / 限制 | 测试实际替换哪里 | 真 runtime / CI 边界 |
|---|---|---|---|
| [Paseo](paseo-findings.md#4-测试层要按替换边界来读) | run token 与 native turn 精确归属；处理 start 回复前事件和迟到终态 | adapter 测试 fake 原生进程 / SDK；daemon 测试常整体替换 AgentClient | 有跨 provider real contract，允许 skip；不能把 fake daemon E2E 算作原生验证 |
| [Lody](lody-findings.md#3-测试层每层究竟替换什么) | operation fingerprint、claim、worker boot fence；provider 已开始后失联记 uncertain；启动阶段限流 | SDK connection mock；子模块 native→ACP；真实 Loro fixture replay；SQLite coordinator + 故障注入；scripted ACP 产品 E2E | opt-in live registry suite；根 CI test 排除 Codex/Claude 子模块测试 |
| [Synara](synara-findings.md#测试层替换点决定证明范围) | journal 失败原地重试、decode quarantine、generation fence；旧 terminal 有明确例外 | adapter + fake native boundary；官方 ACP SDK 模拟端；真实 SQLite/Git + 顶层 fake adapter | 特定 Codex/Cursor opt-in；未发现九 provider 统一真实行为 suite |
| [One Works](oneworks-findings.md#四测试它真的与-oar-重叠范围也要说准确) | Codex failover 仅在提交点前；attempt generation；共享进程 lease；sink append 失败记录后继续，非可靠 terminal journal 保证 | 真 agent runtime + Mock LLM 的共享 E2E；另有单 adapter 测试 | 已有共享离线 harness，不应从其存在推断所有 provider、所有行为覆盖 |
| [Orca](orca-findings.md) | lease 过期不自动授权第二 writer；PID 身份证据；事件 sink 背压/barrier；SSH 断联为 unverifiable | fake native connection；真 Claude SDK + scripted CLI；真实子/孙进程取消；产品 E2E | live CLI 按 binary/auth 条件 skip；未发现全部 TUI agents 共用结构化 suite |
| [Herdr](herdr-findings.md#测试是设计还是回归积累) | 状态单一权威；hook 优先或屏幕规则；保守去抖、boot/generation、handoff 失败恢复 | 真 server/socket/PTY + 假 agent 脚本；hook emitter；冻结协议 fixtures；live handoff 故障注入 | 跨平台 CI，但未发现真实厂商 binary + scripted model 矩阵 |
| [Multica](multica-findings.md#测试层它把-fake-放在哪里) | ResumeRejected 正证据；不安全 session 清理；8 KiB 工具预览、合块、失败 batch 不重试是历史损失边界 | 版本化原生流 + 真 parser；fake executable + 真 Backend；真实 OS 管道/进程故障 | 默认 CI 禁止误用真 CLI；opt-in live；另有每周 OpenClaw 配置兼容 canary |

**总结与 OAR 含义。** 这些项目已经积累了具体的故障协议，OAR 可以直接借鉴其不变量：失联不等于拒绝执行、旧终态不能结束新 turn、父 turn 结束不等于 child 结束。验证也要覆盖真正承诺的边界：纯状态测试验证决策，原生协议替身验证 adapter，真实 binary 配合脚本化模型验证兼容性，再用必要的 live probe 补足证据。One Works 已有共享离线 harness，因此 OAR 需要证明自己的跨 runtime 行为覆盖和可复现性，而不能仅以“有 mock/replay/live 分层”作为优势。

维护时先更新项目 findings 的固定版本与证据，再更新对应单元格；新功能没有证据时写明未核实。这里汇总可比较的机制，OAR 的采纳、拒绝与计划仍放在 design 文档。

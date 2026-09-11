# Herdr：终端工作台如何统一多个 coding agent

核对于 2026-09-08。仓库固定在 [`9e01168b140ce8e3821131345dc82bc2bf9994eb`](https://github.com/herdrdev/herdr/tree/9e01168b140ce8e3821131345dc82bc2bf9994eb)，本地只读浅克隆 `/tmp/oar-agent-research/herdr`。以下依据源码、测试和 CI 配置；未安装 Herdr、厂商 agent 或依赖，未运行测试。`docs/next` 是当前源码配套的 next 文档，涉及能力的结论另与代码核对，不等同于已发布稳定版。

Herdr 是“拥有原生 agent 终端的 server + TUI/CLI/socket 工作台”，不是把各 SDK/ACP 的消息流归一化的 library。README 明确强调保存原生终端，各 agent 仍用自己的 UI、权限交互和扩展；它把多 agent 工作中的窗口、状态、注意力和输入路由统一起来。这与 OAR 有相邻功能，但不能视为同一种 runtime 的重复实现。[产品定位](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/README.md#L26-L38)

## 实际统一了什么

`agent.start(name, kind, pane_id, args, timeout)` 在现有 shell pane 启动原生命令；`agent.prompt(target,text,wait?)`、`agent.read`、`agent.send_keys`、`agent.wait` 提供自动化控制。公共 `AgentInfo` 主要是 terminal/pane/workspace 身份、agent kind/name、状态、启动就绪标志、状态序号及可选原生 session 引用。这里的 agent target 是工作台中的存活对象，不是独立于 PTY 的模型会话。[参数与对象](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/api/schema/agents.rs#L166-L234)

输入仍走终端：`agent.prompt` 等 PTY actor 完成写入再回复；提交前验证当前 agent、拒绝 blocked/尚未就绪状态。发送文本和 Enter 之间默认留 300ms，Windows Codex 则按字节数延长，并明确注释为等待厂商提供 paste-complete 边界之前的 best effort。这是真实原生 TUI 的自动化代价；成功提交不等于得到了厂商协议确认的新 turn。[实现](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/app/api/agents.rs#L13-L24)、[校验与输入](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/app/api/agents.rs#L103-L240)

`prompt --wait` 已认真处理“发送时原来就是 idle，不能立刻以此宣布完成”的竞态：发送前采集事件序号和对象身份，先等新 activity，再等目标稳定状态；5 秒未见 activity 可报 prompt stalled；第二阶段从发送前的序号重放，以免第一阶段消费的生命周期变化丢失。它是可供外部脚本组合的同步控制，不是内置持久任务队列/DAG 调度器。[等待流程](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/api/wait.rs#L177-L319)

## 状态、session、subagent、raw 的边界

状态只有一个权威来源。Pi、OMP、MastraCode、OpenCode、Kilo、Kimi 的完整 lifecycle hook/plugin 激活后暂停屏幕检测；Claude、Codex 等缺少完整 lifecycle 的集成主要提供 native session 身份，状态依靠 live bottom-buffer 的 TOML 规则，部分规则也使用终端 OSC title/progress。不能因为“装了 Claude hook”就认为其状态来自可靠的厂商事件流。[权威来源代码](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/detect/mod.rs#L316-L332)、[设计说明](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/docs/next/website/src/content/docs/agents.mdx#L14-L50)

屏幕启发式有显式保守边界：已知 agent 没有规则命中时默认 idle，并在 explain 输出中标记 fallback；新权限 UI 可能因此被看成 idle。Working→缺少明确证据的 idle 有确认与时间上限；显式可见 idle/blocker 又不套用同样延迟。还有 live bottom 而非用户滚动视口、规则优先级、manifest 版本/来源与命中理由等诊断设计。这是可维护的识别系统，但它的 idle 不足以充当 OAR 的可靠 turn completion 或 goal completion。[fallback 测试](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/detect/manifest/tests.rs#L90-L100)、[去抖逻辑](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/pane/agent_detection.rs#L5-L77)、[诊断与升级](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/docs/next/website/src/content/docs/agents.mdx#L58-L87)

session 分两层：Herdr 保留工作区/终端状态；native session 用 `{source,agent,kind:id|path,value}` 保存，重启恢复计划最终转换成 `claude --resume`、`codex resume`、`pi --session` 等原生命令。它没有据此导入/规范化原生 conversation、tool 调用和 history；断开 TUI 后进程由 server 继续拥有，与冷重启重新运行 resume 命令是两种不同保证。[resume 数据结构与命令映射](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/agent_resume.rs#L8-L33)、[各厂商映射](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/agent_resume.rs#L136-L235)

subagent 不是完全没处理：OpenCode integration 追踪 root/child，子会话的 permission/question 被上卷到正确 root pane 的 blocked/working；测试专门防止 nested child 错投到最近活跃的另一个 root。这个行为保护工作台的状态与原生 session 身份，却没有将子会话图、agent path、分支 transcript 作为公共统一对象输出。[子会话测试](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/integration/assets/opencode/herdr-agent-state.test.ts#L163-L223)

公共事件是 workspace/tab/pane 创建移动、输出匹配、agent detection/status 等；读取的是终端屏幕/scrollback，所谓底层信息保留主要是原生终端内容，不是厂商原始 JSON event 的逐条透传。用于 wait 的 EventHub 是内存中最多 512 条事件的序列，不能把这个序号误称为持久化原生事件 resume cursor。[事件类型](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/api/schema/events.rs#L11-L85)、[EventHub](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/api/event_hub.rs#L1-L46)

## 测试是设计，还是回归积累

两者都有，且有实质设计，不能概括为“只 patch 各厂商 bug”。

- **纯规则/状态层**：有 manifest AND/OR/not、优先级、regex 的通用语义测试；AppState 有身份不变量检查，覆盖唯一 workspace/pane/terminal、引用有效性，以及专门构造的 public number 与内部索引不相等的 adversarial fixture。这些验证抽象约束。[规则语义](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/detect/manifest/tests.rs#L102-L154)、[身份不变量](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/app/state.rs#L1140-L1227)、[对抗身份测试](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/app/state.rs#L1344-L1357)
- **厂商屏幕回归**：Claude 权限提示逐个遍历两种选项布局的所有光标位置；Codex 回归检查已完成回答中引用 `[y/N]` 不会误判为当前权限提示。这里确实在积累 UI 变体和现实故障知识，但例子已从单样本提升为变体与优先级覆盖。[Claude 光标排列](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/detect/manifest/tests.rs#L783-L839)、[Codex stale text](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/detect/manifest/tests.rs#L1169-L1195)
- **fake/native 边界分清**：CLI 集成测试启动真实 Herdr server、socket、PTY，但 `pi` 可以是 PATH 中的 shell 脚本，按时输出 Working/done。Hook 资产测试则 import 真插件，用假的事件 emitter 或 recording socket 注入厂商事件。它们可靠验证本方传输/状态映射，但不证明真实厂商新版仍产生这些输入。[fake Pi + 真 server](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/tests/cli/agent_wait.rs#L109-L199)、[hook harness](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/integration/assets/herdr-agent-state.test.ts#L46-L127)
- **工作台协议/故障测试**：冻结的 v1 handshake/snapshot fixtures、bincode digest 保持跨版本线协议；代码明确承认 digest 不会发现追加 enum variant，要求 v1 类型不可追加。端点激活测试涵盖 ack 次序、陈旧 boot/generation、rollback、resize、latest intent；live handoff 真实 server 测试通过注入 import failure，验证老 server 恢复、子进程存活且仍可读写。这一组比简单 mock method/assert called 更有工程含量。[冻结 fixture](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/protocol/endpoint.rs#L190-L231)、[digest 边界](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/protocol/wire.rs#L1724-L1732)、[激活测试](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/src/client/endpoint/activation_tests.rs#L255-L408)、[live 故障注入](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/tests/live_handoff.rs#L1904-L1988)

CI 配置跑 Linux/macOS/Windows、Rust nextest、hook Bun 测试及 maintenance/架构约束；macOS 排除 `live_handoff` binary，Windows 另有 ConPTY smoke/package 故障检查。在检查到的 CI 与测试入口没有发现安装真实 Claude/Codex/Pi 再接 scripted model vendor 的矩阵，也没有证据支持称其有真实模型端到端门禁。这里应说“配置提供上述覆盖”，不能在未跑 CI 的本次调查中说“测试全部通过”。[CI 矩阵与入口](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/.github/workflows/ci.yml#L41-L147)、[test recipes](https://github.com/herdrdev/herdr/blob/9e01168b140ce8e3821131345dc82bc2bf9994eb/justfile#L6-L97)

## 对 OAR 的实际含义

Herdr 证明“统一多 coding agent”有多种交付边界：用户保留原生 UI，只需要并行运行、回到正确 pane、收到状态提示时，终端 server 已能给出很强体验。OAR 若把“统一 start/prompt/stop/status”本身当护城河，会高估差异；而把整个 Herdr 视为 OAR 的重复实现，会低估工作台自己的终端协议、持久运行、多客户端和远程连接成本。

可复用边界是新增的、程序化的 session 通路：如果工作台要实现自定义统一 transcript、结构化 tool/approval、可追踪子 agent 或可靠 turn 结果，OAR 的厂商协议适配层可能消除重复工作。代价是不能自动保存 Herdr 当下最看重的原生 TUI 体验；较自然的是可选 headless backend，再用桥接集成将运行状态投到 Herdr。已有终端执行路径不应为了统一接口而被强行替换。此处是架构推断，并非 Herdr 当前已采用 OAR。

反向复用，OAR 可以借鉴它的单一状态权威、身份校验、输入提交与开始工作的分离、native session 引用和诊断输出，以及厂商变化回归的组织方式；真正的 PTY 工作台用户甚至可以直接用 Herdr socket API。若 OAR 本身要承诺结构化 turn/events，则 Herdr 的屏幕状态及短内存事件队列无法代替该承诺。OAR 最有机会证明价值的部分仍是可独立消费的公共适配库 + 真实厂商 binary 的协议合约测试，而非泛称所有工作台都在低水平重造 runtime。

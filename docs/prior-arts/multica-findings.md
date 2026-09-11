# Multica：接入抽象、测试接缝与 OAR 判断

调研版本：`261522e3e3d71516d6b34d7c5ab1ccc8a4669718`（main，2026-09-08）。只读源码与 CI 配置，没有安装依赖、运行测试或做线上行为验证。以下链接固定到该 SHA。

## 结论

Multica 有明确设计过的 **任务执行适配层**：`Backend.Execute(ctx, prompt, ExecOptions) -> Session{Messages, Result}`。其长处是很多原生 CLI/协议被统一到执行、事件流、终态、恢复判断和进程生命周期；测试深入到了真实 OS 管道、退出顺序、版本化原生流、上游 CLI 配置语义。它不是一个具有完整交互控制、原始事件连续性和 native child topology 的通用持久会话中间件。

“精心设计”与“逐步补兼容性问题”在这里同时成立。共享协议/启动规则/测试守卫都显示有意识的边界设计；大量 provider-specific options、daemon 内的产品恢复策略又说明这个边界服务的是 Multica 本身。不能从回归用例多或注释提到 bug，反推最初没有架构设计，也不能从代码静态结构推断真实用户规模/稳定性。

## 抽象层：它统一了什么

### 1. 窄执行接口，明确的通道生命周期

[`agent.go:17-23`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent.go#L17-L23) 的唯一 Backend 方法是 Execute。取消使用 Go context；resume 通过下一次 Execute 的 `ResumeSessionID`，不是持久 Session 上的 resume/steer/permission-response 方法。

[`Session:142-175`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent.go#L142-L175) 规定 Messages 先关闭、Result 恰好发送一次。Message 统一 text/thinking/tool-use/tool-result/status/error/log，包含 CallID、SessionID 等字段。这个结果对消费者很好用，但该公开 Message 中没有 native raw envelope、native turn ID、parent-child session 关系；不要把内部协议解析能力等同于对外 fidelity 契约。

[`Result:200-240`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent.go#L200-L240) 的 `ResumeRejected` 特别值得借鉴：true 必须有“原会话不存在/不可恢复”的正证据；false 也可能是无法确定。网络、限流、认证错误不能随便当作 resume rejection。这是可验证的行为语义，价值高于只有统一方法名。

### 2. 统一层内仍容纳明显的 provider-specific policy

[`ExecOptions:25-127`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent.go#L25-L127) 除 Cwd/Model/Timeout/MCP/ResumeSessionID 等通用参数，还有 Codex handshake/no-progress/ServiceTier、QwenpawWorkspace、ClaudeSettingsPath、OpenclawMode 等字段，并约定不支持时忽略。这样的单一参数包能快速支持产品，但消费者不容易从类型本身辨认实际 capability。

[`Config:257-290`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent.go#L257-L290) 也不只包含可执行路径和环境；还带 TaskID、RuntimeID、DaemonVersion、CodexVersion、BuiltinRuntime、LaunchPrefix 等产品信息。SupportedTypes 是 25 个 family 名称的显式白名单，注释要求与数据库 CHECK 迁移保持一致，New 则 switch 建立具体实现。它不是一个可以不改宿主代码就注册新 provider 的通用插件 SDK。

[`LaunchPrefix filter:380-392`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent.go#L380-L392) 把可执行前缀的安全/兼容处理收敛到 factory，注释明确避免每个 backend 单独记忆规则。这是“把已经发现的共性继续收敛”的证据，不应贬为机械堆补丁。

### 3. runtime identity 与协议 family 分离，是明确的扩展设计

[`builtin_runtimes.go:8-70`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/builtin_runtimes.go#L8-L70) 明说：一个 protocol backend 可以支撑多个 runtime identity，registry 同时驱动探测、前端和 skill 相关信息；例如 omp 派生使用 pi family。[`ResolveBackend:131-170`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/builtin_runtimes.go#L131-L170) 是 daemon 的统一入口，override capability 默认拒绝不支持的组合。

ACP 有实际复用，而非每个名字完全重写：[`kimi.go:30-66`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/kimi.go#L30-L66) 复用 `hermesClient` 的 ACP transport，同时处理 Kimi 的参数、MCP 转换和权限策略。权限请求默认选 ACP 所提供的允许选项；这是一种任务执行 policy，不是给最终消费者一个交互 permission request/response API。[`125-148`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/kimi.go#L125-L148) 抑制当前 prompt 前的 history replay，体现会话恢复去重属于 adapter 的实际成本。

### 4. 多 agent 编排属于任务产品，native child 不是此接口的一等对象

[`codex.go:2748-2758`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/codex.go#L2748-L2758) 在有状态 turn gate 前过滤其他/native child thread；[`3218-3238`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/codex.go#L3218-L3238) 同样只有当前 thread 驱动输出。这保护 root run 终态，但与 Paseo 保留 native child topology 是不同产品选择，不能只按“支持多 agent”这一列混为一谈。

[`daemon.executeAndDrain:8848-8888`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/internal/daemon/daemon.go#L8848-L8888) 把进程执行和事件 drain 放在统一 cancellation context，外加超时和 inactivity watchdog。[`8989-9025`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/internal/daemon/daemon.go#L8989-L9025) 在运行中 pin native session，其中 Codex 还要等 rollout 真正落盘后才能 pin，以支持崩溃恢复。这表明影响可靠恢复的知识仍在产品 daemon。

任务委派/失败恢复则使用数据库、coordinator、issue、squad、priority 等产品实体：[`service/task.go:6357-6425`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/internal/service/task.go#L6357-L6425)。OAR 的窄运行时层最多承接其底部执行语义，不能声称替代整个任务编排。

## 测试层：它把 fake 放在哪里

### 1. 版本化原生事件流，通过真实 adapter/parser

[`cursor_stream_fixture_unix_test.go:15-41`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/cursor_stream_fixture_unix_test.go#L15-L41) 回放实采 cursor-agent `2026.07.20` 流。fake 是一个输出 fixture 的可执行 shell 文件，测试仍调用真实 New/Execute/parser，不是直接提供 normalized Message 的 FakeBackend。

[`61-139`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/cursor_stream_fixture_unix_test.go#L61-L139) 固定 reasoning delta 顺序、tool 名称、ID、输入和结果；注释说明过去 top-level thinking/tool_call 会被静默丢掉。它是很实用的 native-protocol regression corpus，但 fixture 不验证未来真实 CLI 一定还输出相同格式。

### 2. 操作系统进程/管道契约，有专门的故障模型

[`claude_deadlock_test.go:15-22`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/claude_deadlock_test.go#L15-L22) 将当前测试二进制 reexec 为 fake CLI child；[`168-215`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/claude_deadlock_test.go#L168-L215) 让 child 在读 128KiB prompt 前先写 256KiB stdout，重现 pipe backpressure 和写入/读取顺序问题。这比 mock spawn 返回若干事件更能覆盖真实死锁。

[`run_collect_lifecycle_test.go:24-82`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/run_collect_lifecycle_test.go#L24-L82) 构造“wrapper 已退出、延迟的 grandchild 仍持有 stdout”情景，要求 DetectVersion 等真正答案与 pipe EOF。[`84-125`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/run_collect_lifecycle_test.go#L84-L125) 又区分 startup banner 与有效版本输出。这里检验的是 adapter 真正必须承担的底层行为，不是重复实现断言。

### 3. 有局部共享 contract，但没有看到全部 providers 的统一运行时矩阵

[`stream_json_final_output_test.go:282-305`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/stream_json_final_output_test.go#L282-L305) 同一 case 遍历 Claude/CodeBuddy，通过 fake executable 调用真实 Backend.Execute；可视作协议 family 内的共享 conformance。不要夸成 25 个 backend 都走同一套完整 lifecycle/resume/cancel/permission 合规矩阵。

[`agent_supported_types_test.go:8-33`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/agent_supported_types_test.go#L8-L33) 保证白名单与 constructor 一致。[`worktree_capability_contract_test.go:12-28`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/worktree_capability_contract_test.go#L12-L28) 则由 Go 测试读取 TypeScript 前端中的 capability token，与 daemon protocol 常量对照。这些是刻意设计的跨层静态 contract，范围与真实运行行为不同。

### 4. 默认 CI 明确禁止误用真实 CLI，live suite 有 gate

[`scripts/go-test-with-agent-cli-guard.sh:19-57`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/scripts/go-test-with-agent-cli-guard.sh#L19-L57) 在 PATH 前放各 agent CLI 的 sentinel；若测试意外执行真实 CLI 名称，记录并使测试失败，即便被测代码吞掉子进程失败。这个设计清楚地区分 unit/fake-process 测试与会消耗真实账户的测试。

[`scripts/test-go.sh:28-41`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/scripts/test-go.sh#L28-L41) 在 guard 下执行常规 Go suites，再限制 agent 包 `-p 2 -parallel 2`，注释解释避免 OS process-heavy tests 因并行资源饥饿触发 deadline；CI [`542-544`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/.github/workflows/ci.yml#L542-L544) 用 `--race` 调用它。

[`real_agent_smoke_integration_test.go:1-15`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/real_agent_smoke_integration_test.go#L1-L15) 同时要求 `agentintegration` build tag 和 `MULTICA_RUN_REAL_AGENT_SMOKE=1`。默认 CI [`524-532`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/.github/workflows/ci.yml#L524-L532) 不跑此类 live case，但用 `go vet -tags agentintegration ./...` 避免长期不编译导致类型腐烂。

真实 smoke 的 oracle 也有较强例子：[`kimi_integration_test.go:103-130`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/server/pkg/agent/kimi_integration_test.go#L103-L130) 的 MCP case 检查实际 MCP 进程写出的调用记录和 sentinel 结果，而不是只信模型口头宣称工具执行成功。受 POSIX/CLI 存在及 live gate 约束。

### 5. 重要例外：每周真实 OpenClaw 配置兼容性 canary

不能概括为“CI 从不跑真实 CLI”。[`openclaw-config-smoke.yml:3-30`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/.github/workflows/openclaw-config-smoke.yml#L3-L30) 有手动+每周调度，矩阵是 `extended-stable/latest/beta`，故意追踪浮动版本。

[`48-75`](https://github.com/multica-ai/multica/blob/261522e3e3d71516d6b34d7c5ab1ccc8a4669718/.github/workflows/openclaw-config-smoke.yml#L48-L75) 安装实际 CLI、显示版本，以 live gate 运行 `TestPrepareOpenclawConfigRealCLI`；脚本明确拒绝 SKIP，必须检查到 PASS。这验证上游真实 config loader 对生成配置的理解，不是付费模型推理/端到端 agent 任务。准确描述应分开默认 CI、真实 CLI canary、真实模型 smoke。

## 对 OAR 价值与必要性的含义（分析判断）

- **支持共性成本确实存在。** stdout drain、process tree 退出、恢复状态不确定性、原生流 drift、replay 抑制，不是产品 UI 特有问题；多个项目都在承担。这支持抽取 runtime 语义和兼容性测试基础设施。
- **削弱“统一 Backend 接口本身就是充分差异化”。** Multica 已有窄接口和大量深回归；Paseo 则偏持久交互会话，OneWorks 有真实 CLI+Mock LLM 的统一离线 harness。统一 send/execute 或 adapter 数量不是尚无人做的空白。
- **需要避免产品策略泄漏。** Multica 的任务 DB/coordinator 恢复、默认自动批准、特殊配置路径和 Codex rollout pinning 不一定都适合外部通用契约。OAR 应声明哪些是保障执行语义的机制，哪些由消费者提供 policy。
- **可交付的区别应是外部可消费的兼容性承诺。** 例如共享 failure/lifecycle conformance；明确 native ID、raw event、replay/live continuity 的保真边界；版本化 fixture 与真实 CLI canary；capability 的显式 unsupported/unknown 行为。再用第二个真实消费者验证可以减少多少重复实现，而不是只在 OAR 仓库里证明 API 好看。
- **静态研究尚不能证明“必须用 OAR”。** 尚需验证第三方消费者愿不愿采用独立依赖、Go 产品消费 TS/其他语言中间件的成本、维护和适配义务如何分担。无证据把产品用户数或成功归因到抽象层质量。


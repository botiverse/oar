# OAR 价值反方/校准评审

静态读取本地 OAR README、design/spec、实际 contracts、sea-trial、CI；结合固定 SHA 的 Lody 调研。未运行测试、未改 OAR。以下是决策校准，不是完整实现审计。

## 判断

**Lody 证明这类问题难且有人认真解决，不能证明 OAR 没有价值；但也明显推翻“其他工作台只是随便拼 adapter、等用户报错”的强叙事。OAR 当前最可信的价值是把可复用集成与持续兼容测试做成独立公共库。完整、无损、自带归属、可续读的 record 协议目前是待验证的价值假设。**

“必要”应解释为后来者采用它比自己做更划算，不要求发明前人没有的抽象。单个工作台内部实现很好，仍不等于它为别的产品提供了稳定、可直接采用的库；反过来，公共库标签也不自动带来复用性和维护优势。

## 已有事实 / 草案 / 不可宣称

| 事项 | 已核实事实 | 不能扩大成 |
|---|---|---|
| 独立包 | `@botiverse/oar` 为可发布 ESM 包，CLI 分包，浏览器可用 observe 子路径；Runtime 有 session 核心和 installation/accountUsage/listModels 可选函数 | 已被多个外部产品稳定采用；已提供统一 install/login 全流程 |
| 运行时控制 | 当前 `Session/Turn v1` 有 prompt/busy、turn outcome、abort、optional steer/queue、native session id/resume、model/context read-back | 完整的多控制者调度层、durable operation、权限系统、远程分布式 session |
| 事件 | 当前有带 sessionId/turnId/seq 的归一化事件与观察派生层 | 所有 native event 保留、完整 subagent 归属、任意位置续读和 record request/response 契约 |
| 自动验证 | 3 OS × Claude/Codex/Pi aimock，真实 runtime/adapter，仅 model provider 脚本化；同公开 API suite + vendor 测试 | 五种 runtime 全能力全面契约验证；真实登录/live model 在 CI；所有支持版本均验证 |
| replay | 真生产 projection 回放 fixture | 无损公共事件接口已实现；原生未知字段完全保真；完整 record cursor 恢复 |
| record 协议 | 调研时 spec 明标 `DRAFT v0.8`；完整 attributed/resumable stream、graph、request/response 和更强 capability 都在此设计中 | 已优于 Lody 的交付事实 |

源码锚点：

- [Runtime 当前接口](../../packages/oar/src/contracts/runtime.ts#L6)：只有 session、installation、accountUsage、listModels。design 提到 detect/install/login/version-window 是目标面，不能只读愿景当现状。
- [Session v1 范围](../../packages/oar/src/contracts/session.ts#L3)：ownership 是 object reference，多控制者仲裁明确归 host；YOLO 默认、interactive permission settlement/remote model deferred；pi session-scoped events 目前主动丢弃。注释还说 resume deferred，但当前 options/实现已支持部分 resume，因此该句有局部过期，不能照搬成完全没有 resume。
- [当前事件 union](../../packages/oar/src/contracts/session.ts#L156)：只有 turn_started/text_delta/reasoning/tool_call_started/tool_call_ended/turn_ended，无公共 native raw body 或 agentPath；seq 严增不是可续读 API。
- [spec 状态与 promise](../../docs/spec/README.md#L3)，[能力声明尚 open](../../docs/spec/README.md#L52)。`design/motivation.md` “everything emits available”“hard problems solved once” 应解读为设计目标，不是当前完成清单。
- [真实 aimock backend](../../sea-trial/harness/backends.ts#L39)，[CI matrix](../../.github/workflows/ci.yml#L26)。Claude/Codex CI 装 latest，属于最新版本漂移探测，不是支持窗口矩阵证明。

## Lody 反证了哪些自我叙事

1. **不是“精心设计”对“靠用户回归”的二选一。** Lody 有 reduced executable model 穷举 race traces，有真实 SQLite/coordinator 的故障注入，还对 real Mirror 反馈环写集成回归。这是生产问题驱动后抽象出安全不变量的工程；回归来源于用户问题不降低测试质量。只凭文件叫 repro 或补丁多，也不能判断是草台。我们没有历史数据量化各项目多少 bug 用户先发现。
2. **公共抽象不是 OAR 独有。** Lody 已把 ACP adapters 与扩展 core 拆为公开子模块；它们可能成为后来者直接选用的组件。OAR 应与“ACP SDK + 现成 adapter + 少量 glue”的现实替代方案比较，而非只与“每个人从零实现五家协议”比较。
3. **Lody 的有损持久历史不证明它协议层做坏了。** 它有意控制 CRDT transcript 体积、剥离大 tool 输出；这是产品投影选择。OAR 如定位生产者，保真有意义，但应比较原生事件入口/公共产出，不能拿自己的原始层对比别人的 UI 历史层。
4. **不会有一个库消掉所有多 Agent 调度难题。** Lody 的 user priority、operation/delivery、restart fencing、跨 replica uncertainty、权限和 worktree 所有权是 host 层责任。OAR 自己明确不做 storage/多控制者，不能宣传替代整层 Lody 调度。最有价值的是给 host 足够的可观察执行事实和语义明确的命令结果，减少 host 对 vendor 的猜测。
5. **OAR 当前不能直接替代 Lody 接入层。** 当前权限默认跳过、interactive settlement deferred，已足以阻挡依赖交互审批的工作台整体替换。新 headless/AX 服务或 observer/eval 工具，可能是更合适的早期采用者；这是用户画像假设，需要外部验证。

Lody 证据见 [完整调研](lody-findings.md)，尤其 operation-model + real coordinator 与根 CI 的边界部分。

## OAR 当前测试的真实强点和盲点

强点是 **脚本化 model provider、保留真实 vendor runtime 和真实 OAR adapter**，相对于 Lody desktop 的 scripted ACP 替身，这条 CI 路径覆盖更深：能发现 runtime 的请求构造、错误处理、process/OS 差异，确实有公共库的兼容实验室价值。公开 behavior case 与 vendor-side case 按观察边界分离，设计比简单一堆 mock-call 断言强。

但“有同 suite”不等于契约已经足够强。当前 9 个 session cases 覆盖 framing、busy、abort、late steer、observer、multi-turn、mid-turn steer、queue、resume。mid-turn steer 只要求不弄坏 turn，未证明输入可见/交付；abort 容许自然完成；resume 容许名字含 resume 的拒绝，成功时主要检查同 id + 再次能 prompt，未证明上下文连续；optional queue absent 时直接返回也记为通过。这些容许在共享最低承诺里合理，但要另有强能力声明 + 该能力专项证据，不能拿所有 green 宣称强能力成立。[cases](../../sea-trial/cases/session.ts#L132)

backend unavailable 会 exit 0；缺 optional capability 的 case 为 skipped；最终摘要用 total-failures 计算 clean，skipped 也计入 clean。CI 上传 artifact may catch 某些完全没跑的情况，但仍应报告 **执行数/跳过原因/强能力覆盖率**，不要只看 green。[entry](../../sea-trial/main.ts#L24)、[summary](../../sea-trial/main.ts#L45)、[runner](../../sea-trial/harness/runner.ts#L22)

## 最强价值假设

**OAR = 可独立采用的 runtime 控制契约 + 保真/归属的观测接口 + 持续运行的兼容验证资产。** 核心价值不是“更漂亮 interface”，而是 vendor 升级、OS 问题、steer/resume/error 边缘由一处吸收并向所有宿主发布修复。即使今天别人已经在内部解决，同类劳动只做一次仍有价值。

最强技术切口是 **让 host 不必理解 vendor 的 transport/turn ownership/未知事件/能力差异，也不因统一而失去真实语义**。用两个不同类型的实际消费者检验：一个 headless 控制器，一个 observer/trajectory 工具。不要仅用 coxswain 自己证明通用性。

## 最有力失败条件与验证指标（建议验收门槛，不是已测结果）

| 假设 | 如何验证 | 失败信号 |
|---|---|---|
| 能减少集成工作 | 让 2 个独立消费者各接入至少 2 个 runtime，记录首个完整用例耗时、vendor-specific 分支/escape-hatch、升级后的消费者改动量；与 native SDK/ACP 方案对比 | 用 OAR 后仍需维持几乎相同的 vendor glue，或更难调试 |
| 修一次可多人收益 | 连续追踪约 6–8 周真实 runtime 升级，记录被 CI 提前检出的 breaking changes、修复时延、消费者是否可只升级包而不改业务代码 | 各 consumer 仍须私有 fork/补丁；维护速度追不上各 vendor |
| record 协议的归属/保真是刚需 | 最少两个明确消费场景，重放 runtime raw fixture 后核对未知字段、child attribution、会话图/恢复前后投影；测试完整数据而非只 event-kind snapshot | 用户实际只用 text/tool feed，graph/raw/cursor 不能减少业务 bug，却使 API 明显复杂 |
| conformance 是可信资产 | mandatory backend 在 CI 未运行则失败；分列 pass/skip/unsupported；维护 capability × runtime × OS × version 的执行证据 | 绿色主要来自 skip 或容许 silent unsupported，强 steering/resume/child 场景长期只靠手工 probe |
| 独立库优于 ACP 组合 | 用同一目标 feature 比较 OAR 与公开 ACP adapters，量化 OAR 独有可观察数据、兼容成本和迁移成本 | ACP 标准/adapter 已足够且更快支持新能力，OAR 只重复包装还引入一轮版本滞后 |

建议把第一轮价值验收设为：**两个外部消费者、每个两个 runtime、跨至少一次 vendor 更新，只升级 OAR 即保持业务代码稳定**。这比更多设计文档、更多 runtime logo 或声称无损更能说明项目值得继续。若短期没有采用者，也可先交付可单独使用的 conformance harness/fixtures；测试资产可能比完整抽象更早产生公共价值。

总评：应该继续验证这个方向，但应把“已构建的集成/测试价值”与“record 协议承诺”拆开。研究 Lody 的结论是借鉴其恢复不变量与成熟兼容模式，不是复制其整个调度控制面，也不是用它的存在取消公共库的意义。

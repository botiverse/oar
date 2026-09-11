# 综合判断的独立反驳审查

读取 oar-value-review.md 与 Synara、One Works、Paseo、Lody、Orca findings；未重新运行测试或全面审计源码。以下审查结论框架，而不是给项目可靠性排名。

## 总体意见

暂定结论基本成立：认真设计与生产反馈不是二选一；已有公共部件/统一harness反证“没人做”；OAR仍可能通过共享维护减少重复劳动，但必须体现净收益。不过建议校准以下几点。

## 需要收紧的结论

1. **A厂商适配/B会话控制观测应成库，C产品调度留宿主：不能理解为B所有内容天然都应进同一个库。** adapter能提供的事实（原生turn身份、accepted/rejected/unknown receipt、定向cancel、native permission request）与host能保证的事（durable acceptance、多控制者ownership、重启重放、任务幂等）不同。库可以提供可组合primitive和测试，不必内置一个存储/租约策略；反过来，如果库隐藏前一类事实，host无法安全实现后一类政策。Orca/Lody的恢复语义说明边界依赖双向契约，不能简单“故障全归C”。参考 [Orca findings](orca-findings.md) 与 [Lody findings](lody-findings.md)。

2. **权限不能整体归宿主而省掉运行层协议。** 请求源session/turn、答复作用范围、取消后过期请求、已回答去重是B的事实/控制契约；用户是否默认同意、权限配置模板属于C。OAR当前YOLO/deferred interactive settlement不仅是“暂不做产品策略”，也会挡住需要approval的真实下游。应将“暂不服务这类下游”或“补交互协议”作为明确选择，而非声称已可替换完整工作台接入层。依据 [OAR校准评审](oar-value-review.md)。

3. **raw/attribution/graph既不是当前领先点，也不是天然最有价值的下一步。** raw保真是生产者接口性质，和UI投影压缩不能同层比较。它还增加敏感内容、存储体积、重放成本、CLI版本绑定；全量graph可能为少数consumer有用，但大多数可能只需要稳定root/child/turn关联。先验证具体消费场景再扩展到全部v2。已有产品的canonical stream是有意损失，不等于他们“没做好”；OAR没有义务为无需求的未知event建立重型公共对象。参考 [One Works findings](oneworks-findings.md)、[Synara findings](synara-findings.md)。

4. **共享suite不自动等于强契约；真runtime+mock LLM也不自动优于其他所有测试。** 它能覆盖真实CLI请求/配置/工具loop，不能覆盖真实鉴权、厂商服务、真实模型时序。反过来，Orca的真实OS进程测试、Synara的SDK reference peer与可控race window、Lody的reduced model各自能验证它不擅长的风险。OAR当前case允许自然结束/弱steer/resume拒绝，本来可以是合法最低承诺，但应将强capability evidence单列，别用统一green制造一致性幻觉。

5. **公共包不等于低采用成本；工作台内部也不等于不可复用。** One Works确实有package分离与public boundary测试，Lody有公开ACP adapters。OAR必须与这些实际替代方案比较，不是“每个人从零实现5家协议”。模块可能只是技术上可导入，稳定API/文档/独立依赖/版本支持仍需实测；同理OAR可发布ESM也不能直接证明更轻。

6. **“两个不同下游×两个runtime×一次升级”是实验设计，不应当成普适成功判据。** 如果两个都由OAR作者、同一宿主框架/相同需求开发，证明较弱；一个独立团队维护的需求复杂consumer可能比两个演示更有力。应让consumer事先写验收任务，与native SDK/ACP组合做对照。provider-specific分支数量只是proxy，不能把合理的native feature escape hatch视为失败；更重要的是必须理解多少vendor知识、故障是否可诊断、升级时谁需要改代码。

7. **维护收益不是“修一次多人受益”就成立。** 公共层也会成为版本滞后和单点维护瓶颈。需要声明支持窗口、release节奏、回滚/降级和escape hatch；latest CI只是漂移探测，不代表旧版本仍支持。采用者能否无业务修改升级，比adapter数量更重要。

8. **样本选择限制要说清楚。** 这些大多是AI工作台/任务产品，证明它们共享一部分coding-runtime难题；不能据此推断observer/eval、headless automation、远程执行平台都应共享同一B层。测试fixture与runtime compatibility甚至可能比统一控制库更先独立产生价值。也不宜从代码规模、星数或补丁密度推用户反馈数量、设计起因和运行可靠率。

## OAR最值得先做的三项

### P0：让现有 conformance 报告成为可信证据

不先加更多runtime。mandatory CI backend不可用应失败；分列pass/skip/unsupported/未执行；按runtime×OS×版本×capability输出执行账本。将最低合同与强能力probe分开：steer输入是否真的进入运行中的turn、resume是否保留上下文、cancel是否只终止目标turn且旧事件不污染后续turn。对照当前case允许的结果，明确哪些是支持、哪些只是没有破坏会话。

验收：单看artifact即可确定哪个保证在何环境实际执行，不需从绿色exit推断。

### P1：选一个下游需要的最小“交付与生命周期”切口

不要同时实现整个v2。优先补能让host不猜vendor状态的事实：command receipt accepted/rejected/unknown，稳定session/turn/native引用，定向取消与late-event fence；若目标下游有approval，则包括request绑定/过期答复语义。借鉴Orca unknown不可重发、Synara stale terminal安全收尾、Paseo interrupt ownership、Lody uncertain执行处理。对照真实adapter做可控故障注入和OS进程资源验证；host存储和用户优先级仍由host提供。

验收：同一宿主控制逻辑面对至少两runtime的response丢失/取消竞态/重连，不必追加vendor分支。

### P2：真实对照采用实验，并允许测试资产先独立交付

选两个形态不同且至少一个有独立维护者的consumer，分别与现成ACP组合/One Works packages或native SDK比较。提前记录功能和失败场景，不只count LOC；跨一次vendor升级，观察采用方改动、诊断耗时、库修复发布时延。若raw/replay的需求只来自observer，可先给它最小记录面，不迫使所有控制consumer承受完整graph。若主要收益来自CI/fixtures，承认并先交付compatibility harness也合理。

验收：证明OAR减少了必须由consumer掌握的vendor知识和持续维护工作，而不是只是把同样代码换个目录。

## 建议最终主结论

“这些产品已经认真解决了许多统一接入和调度问题，但解决范围随产品而异；它们不能互相替代，也没有证明公共库无价值。OAR的价值应是可独立采用的契约与持续兼容维护，而非抽象的首次发明。这个价值目前有实现基础、有竞争替代，也有尚未交付的承诺，需要以具体下游和升级故障实验验证。”


# Prior arts

这里维护与 OAR 相关的 agent runtime、工作台、远程控制和多 agent 编排项目调研。

每份调研应固定源码版本，并区分：

- 已从源码、测试或 CI 核实的事实
- 项目文档中的设计目标或草案
- 基于证据作出的判断
- 尚未运行或无法由静态阅读证明的内容

优先记录接入抽象、会话与事件身份、取消/恢复/权限语义、原生子 agent、持久化与故障处理，以及测试实际替换了哪一层。不要用 star 数、测试文件数量或 opt-in 测试的存在替代真实运行证据。

## 当前调研

- [Synara](synara-findings.md)
- [Paseo](paseo-findings.md)
- [Lody](lody-findings.md)
- [One Works](oneworks-findings.md)
- [Orca](orca-findings.md)
- [Herdr](herdr-findings.md)
- [Multica](multica-findings.md)

综合判断：

- [OAR 价值校准](oar-value-review.md)
- [综合反方审查](synthesis-review.md)
- [One Works 测试审计](oneworks-tests.md)

## 新增调研模板

新增项目时，建议至少包含：

1. 项目定位和固定 commit/tag
2. 接入层与宿主编排的边界
3. session、turn、event、native identity 和 child 关系
4. 取消、恢复、断连、重复投递和权限语义
5. 测试替换边界、真实 runtime 覆盖和 CI 执行条件
6. 对 OAR 的可复用启示、限制和可验证假设

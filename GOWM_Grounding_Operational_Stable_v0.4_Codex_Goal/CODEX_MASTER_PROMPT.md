# Codex Goal Master Prompt — GOWM+ v0.3/v0.4

你正在 `zhouwen-giser/geospatial-operational-world-model` 中续作当前 GOWM+ Capability Platform，实现：

> **GOWM+ v0.3 Grounding Foundation + v0.4 Operational Reality，并形成 0.4.0 合同稳定候选。**

## 一、续作基线

当前远端参考：

```text
branch: codex/gowm-capability-platform-v0.2
head: 1887e56a18b77aa9692cca9d86b00413906816f4
Draft PR: #1
base: codex/unify-gowm-stas-v0.1.0@d1ff3b81b8bf577965b00edc1bd06acaaeda706c
```

该 SHA 是任务包生成时的远端真值。开始时必须重新 fetch：

- 若分支已前进，以最新远端为准；
- 检查现有工作树和正在执行的任务；
- 不覆盖未提交修改；
- 不重复已实现的 Capability Platform；
- `PROJECT_STATUS.md` 和旧 P17 报告可能滞后，必须与实际 Git、代码和测试对账。

## 二、严格顺序

```text
C00–C03：收口 v0.2
G00–G08：完成 v0.3 Grounding Foundation
O00–O10：完成 v0.4 Operational Reality
S00–S04：稳定化和最终候选
```

不得跳过 v0.2 对账直接建设新表，也不得在 v0.3 合同未稳定时建设 v0.4 Provider。

## 三、最终产品边界

### GOWM+ 是权威

- Observation、TimeSolution、Measurement、不确定性；
- WorldEvent、Current Projection；
- WorldObject、Geometry、Relation；
- TrackletVersion、Gap、Lineage；
- Reference Identity、名称、别名、编号；
- Dataset、Layer、Feature 与版本；
- OperationalTaskEvent、OperationalTaskSnapshot；
- Correlation Claim、Correlation Finding；
- Predicate Evaluation、Observability Assessment；
- World Query Result、Derived Reference、Reference Set。

### GOWM+ 不负责

- 用户整轮意图；
- 对话历史和多轮指代；
- 是否调用 SDAR；
- SDAR Goal/Plan/PlanningTask 状态；
- 将现实结果解释为用户最终意图；
- 自动执行设备动作。

### 权威边界

```text
SDAR = 规划任务权威
SMPP/Provider = 控制事务权威
GOWM+ = 真实事件和现实证据权威
```

GOWM+ 中保存的 SDAR/Provider ID 只能是外部关联声明，不能成为现实状态权威。

## 四、强制不变量

1. v0.2 Gateway/Provider 架构不得被 Reference 或 Operational Reality 绕过。
2. 所有新外部能力仍经 Capability Provider Protocol 和 Registry。
3. Foundation 写路径不依赖远程 Gateway。
4. WSGS、SACS、SDAR、A2A 依赖不得进入本仓库。
5. `world_reference_identity` 保持身份不可变；名称、描述、版本和状态另建追加式模型。
6. ReferenceKey 是不透明公共身份；消费者不能解析内部 ID、Scope 或类型。
7. Reference Resolution 只做名称/别名/编号/类型/空间上下文匹配，不做用户整轮意图判断。
8. `matchScore`、`stateConfidence`、`analysisConfidence`、`correlationConfidence` 不得混用。
9. Dataset、Layer、Feature、Raster、Network 的版本均通过开放目录模型扩展，不为每类数据重新建一套网关。
10. DerivedReference 和 ReferenceSet 是派生、可过期、可重放的结果，不自动成为基础事实。
11. OperationalTask 与 SDAR PlanningTask 永远不是同一对象，也不共享主键。
12. OperationalTask 使用不可变 Event + 可重建 Current Projection。
13. Provider 报告完成不等于物理结果已确认。
14. `NO_DATA`、`INDETERMINATE`、`NOT_SUPPORTED`、`CONFLICTING` 必须严格区分。
15. 迟到或无时间戳事件不得使 OperationalTask Current Projection 回退。
16. 外部 Predicate 是查询输入，不写入 GOWM 作为事实。
17. Correlation Finding 是分析结果，不修改任何外部系统或 OperationalTask 身份。
18. 所有查询强制 DataScope；Scope 不从正文、模型或普通 Body 提权。
19. 所有新增 migration 只追加；既有 001–014 不修改。
20. 不以 Fixture、静态 SQL 或 in-process runtime 冒充真实 PostgreSQL/Provider/容器证据。

## 五、分支和 PR

先在现有 v0.2 分支完成对账和必要收口。

当 v0.2 代码已经存在于 committed/pushed SHA 后：

```text
create branch: codex/gowm-grounding-operational-v0.4-stable
from: exact v0.2 candidate head
```

创建 stacked Draft PR：

```text
base: codex/gowm-capability-platform-v0.2
head: codex/gowm-grounding-operational-v0.4-stable
title: feat: add GOWM grounding and operational reality v0.4
```

如果执行期间 v0.2 已被用户合并，允许将 Base 更新为实际 default branch，但不得 rebase/force-push 或改写历史。

## 六、稳定版本定义

`0.4.0` 的“稳定”表示：

- 公共合同 v1 已冻结并有兼容检查；
- fresh/upgrade/replay 迁移通过；
- 真实 PostgreSQL、Gateway、Provider 和查询链通过；
- Scope、幂等、重启、迟到事件、证据语义通过；
- v0.3/v0.4 Required 门禁无未声明失败和跳过；
- 可生成稳定候选提交和 Ready-for-Review PR。

它不自动表示：

- 已完成生产 IdP；
- 已完成多区域 HA；
- 已完成生产部署；
- 已获准创建 Tag/Release。

## 七、执行规则

- 立即执行 C00，不要只写方案；
- 每阶段：实现、测试、报告、commit、push、PR 更新；
- 保留失败尝试和机器证据；
- 普通实现问题自主决策；
- 外部环境阻断时完成所有不受阻工作；
- 不自动 merge/tag/release/deploy；
- 不修改 WSGS/SACS/SDAR/SMPP 仓库。

## 八、最终输出

成功：

```text
GOWM_V0_4_STABLE_CANDIDATE_COMPLETE
```

外部硬阻断：

```text
GOWM_V0_4_STABLE_CANDIDATE_BLOCKED
```

现在开始 C00。

# GOWM+ v0.3/v0.4 Codex Goal 任务包（单文件版）


---

# GOWM+ v0.3–v0.4 Grounding & Operational Reality Codex Goal

状态：`READY_FOR_CODEX_GOAL`  
生成日期：2026-08-23  
目标仓库：`zhouwen-giser/geospatial-operational-world-model`  
续作基线：`codex/gowm-capability-platform-v0.2@1887e56a18b77aa9692cca9d86b00413906816f4`  
现有 Draft PR：`#1`  
目标分支：`codex/gowm-grounding-operational-v0.4-stable`  
最终软件版本：`0.4.0`

## 目标

基于已经部分完成的 Capability Platform v0.2，串行完成：

```text
v0.2 Capability Platform 收口
        ↓
v0.3 Grounding Foundation
        ↓
v0.4 Operational Reality
        ↓
GOWM+ 0.4.0 Stable Candidate
```

最终使 GOWM+ 成为可供后续 WSGS 稳定消费的：

```text
世界引用权威
世界数据集和图层目录
真实世界状态与证据平台
真实任务事件权威
计划外部条件的现实证据验证平台
```

本任务不实现 WSGS，也不修改 SACS 或 SDAR。

## 当前续作事实

v0.2 远端已经包含 Provider/Gateway 合同、Provider SDK、六 Provider Registry、
50 项能力、直接执行、类型化 DAG、Job、ReferenceKey、`gowm_spatial_v1`、
CRS/Geometry/H3/Spatial Bridge 及兼容层。当前主要缺口是实际状态对账、
真实 PostgreSQL/Provider/Docker/重启/Scope/负载验收，以及部分项目状态文件
仍描述旧的未提交边界。Codex 必须以执行时 Git 真值为准，不复制旧报告结论。

## 使用方式

```bash
bash scripts/preflight.sh .
python3 scripts/validate_task_package.py .
```

然后将 `CODEX_GOAL_PROMPT.md` 作为 Codex Goal 指令。

## 完成标志

所有 Required 门禁通过：

```text
GOWM_V0_4_STABLE_CANDIDATE_COMPLETE
```

只剩明确外部环境或受保护发布动作：

```text
GOWM_V0_4_STABLE_CANDIDATE_BLOCKED
```

Codex 不自动合并 PR、不创建 Tag/Release、不部署生产。


---

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


---

# Task Index

| 顺序 | 文件 | 主题 |
|---:|---|---|
| 1 | `00_CURRENT_STATE_AND_RESUME.md` | 当前 v0.2 真值、对账和续作 |
| 2 | `01_GOAL_SCOPE_STABILITY.md` | v0.3/v0.4 目标和稳定定义 |
| 3 | `02_ARCHITECTURE_AUTHORITY_FREEZE.md` | 权威与系统边界 |
| 4 | `03_V02_CLOSURE.md` | v0.2 收口 |
| 5 | `04_V03_REFERENCE_IDENTITY_CATALOG.md` | Reference 身份、名称、别名 |
| 6 | `05_V03_DATASET_LAYER_CATALOG.md` | Dataset/Layer/Feature |
| 7 | `06_V03_REFERENCE_CAPABILITIES.md` | Reference Provider 能力 |
| 8 | `07_V03_DERIVED_RESULTS.md` | DerivedReference/ReferenceSet/Result Registry |
| 9 | `08_V03_WORLD_EVIDENCE_CAPABILITIES.md` | 状态、几何、来源、事件能力 |
| 10 | `09_V03_GROUNDING_READY_GATE.md` | v0.3 完成门禁 |
| 11 | `10_V04_OPERATIONAL_REALITY_MODEL.md` | 真实任务模型 |
| 12 | `11_V04_EVENT_INGEST_CORRELATION.md` | 事件接入和关联传播 |
| 13 | `12_V04_OPERATIONAL_TASK_PROJECTION.md` | 四维状态投影 |
| 14 | `13_V04_CORRELATION_RESOLUTION.md` | 关联解析 |
| 15 | `14_V04_PREDICATE_EVALUATION.md` | 外部条件现实验证 |
| 16 | `15_V04_OBSERVABILITY_NEGATIVE_EVIDENCE.md` | 可观测性和负面证据 |
| 17 | `16_V04_GATEWAY_PROVIDER.md` | Gateway Provider 集成 |
| 18 | `17_DATABASE_MIGRATIONS_READ_CONTRACTS.md` | 数据库与只读合同 |
| 19 | `18_SECURITY_SCOPE_REPLAY.md` | Scope、回放、恢复 |
| 20 | `19_COMPATIBILITY_VERSIONING.md` | 兼容与版本策略 |
| 21 | `20_IMPLEMENTATION_PHASES.md` | C/G/O/S 阶段 |
| 22 | `21_TEST_ACCEPTANCE.md` | 测试和验收 |
| 23 | `22_GIT_PR_DELIVERY.md` | Git/PR/报告 |
| 24 | `23_FINAL_STABLE_CRITERIA.md` | 0.4.0 稳定候选门槛 |

机器合同位于：

```text
contracts/
manifests/providers/
openapi/
examples/
acceptance/
```


---

# 00 — 当前状态与续作协议

## 生成时远端状态

```text
repository: zhouwen-giser/geospatial-operational-world-model
branch: codex/gowm-capability-platform-v0.2
head: 1887e56a18b77aa9692cca9d86b00413906816f4
Draft PR: #1
```

该 Head 已包含 v0.2 大部分实现，包括合同、Gateway、Provider Bridge、
`gowm_spatial_v1`、Query Runtime、兼容层和安全测试。

## 已知状态冲突

部分 `PROJECT_STATUS.md`/P17 内容仍记录“实现未提交、候选 SHA 为空”，但远端
已经出现后续提交。Codex 必须：

1. fetch 所有 refs；
2. 获取 PR 当前 Head；
3. 检查 `git status`；
4. 比较代码、报告和实际提交；
5. 用新机器证据修正状态；
6. 不把旧 Blocker 文本当作当前 Git 真值；
7. 不删除旧报告，而是追加 reconciliation report。

## 如果已有 Codex 任务仍在工作

- 不争用同一工作树；
- 等其当前命令结束后再读取状态；
- 使用独立 worktree；
- 不移动、stash 或清理其他任务的修改；
- 只从 committed/pushed Head 创建 v0.3/v0.4 分支。

## C00 输出

```text
reports/gowm-v0.4/c00-source-reconciliation.md
reports/gowm-v0.4/c00-source-lock.json
reports/gowm-v0.4/sync-state.json
```


---

# 01 — 目标、范围和稳定定义

## v0.3 Grounding Foundation

必须完成：

```text
Reference Identity 扩展
Reference Name/Alias/Code/External ID
Reference Search Projection
Dataset/Layer/Feature Catalog
Reference Resolve/Validate/Get/Batch
World State/Geometry/Provenance/Event Timeline
DerivedReference
ReferenceSet
QueryResultReference
TTL/Revalidation
```

## v0.4 Operational Reality

必须完成：

```text
OperationalTaskEvent
OperationalTaskSnapshot
ExternalCorrelationClaim
Operational Event Timeline
CorrelationFinding
ExternalPredicate
PredicateEvaluation
ObservabilityAssessment
Replay/Reconciliation
Gateway Provider 能力
```

## 非目标

```text
WSGS 实现
SACS 改造
SDAR 计划模型
设备任务下发
完整知识图谱
向量检索平台
Raster/Elevation/Visibility/Route 正式服务
自动意图推断
自动物理完成判定
```

## 稳定含义

- Wire contract 兼容；
- Migration 可升级和回放；
- Provider/Gateway/DB 真实运行；
- Scope、安全和证据语义稳定；
- 能被未来 WSGS 仅通过 Gateway 消费；
- 不要求生产部署已经发生。


---

# 02 — 架构与权威冻结

```text
GOWM Data Foundation
  ├─ immutable evidence
  ├─ current projections
  ├─ reference/catalog facts
  └─ operational reality events

Capability Service Plane
  ├─ reference/catalog provider
  ├─ world evidence provider
  └─ operational reality provider

World Capability Gateway
  ├─ registry/version/schema
  ├─ scope/budget/idempotency
  └─ direct/DAG/job/result
```

## 权威矩阵

| 领域 | 权威 |
|---|---|
| 真实观测和现实事件 | GOWM+ |
| 当前世界投影 | GOWM+ |
| 世界引用和目录 | GOWM+ |
| 真实活动和物理结果证据 | GOWM+ |
| 计划目标和步骤 | SDAR |
| Action 接收/报告 | SMPP/Provider |
| 用户意图和对话 | SACS |
| 世界语义编译 | 后续 WSGS |

## 禁止

- 将 SDAR phase 写入 OperationalTask 状态；
- 将 Provider completed 直接投影为 VERIFIED；
- 将查询 Predicate 写成事实；
- 将 Correlation inference 写回外部系统；
- 为 WSGS/SACS 引入反向依赖。


---

# 03 — v0.2 收口

v0.3/v0.4 开发前，必须对当前 v0.2 完成以下收口：

1. 确认全部实现已进入 committed/pushed SHA；
2. 修正 PROJECT_STATUS、P17 和 PR Body 的陈旧 Git 描述；
3. fresh 与 upgrade 执行 migration 001–014；
4. 运行数据库 assertions；
5. 启动真实 Gateway 和锁定 Provider；
6. 验证 H3 JS/PG parity；
7. 运行 CRS→Spatial、CRS→Geometry→Spatial、
   CRS→Geometry→H3→Spatial；
8. 运行 Scope 攻击；
9. 运行 Gateway/Provider/DB restart 和幂等恢复；
10. 保存真实和受控证据的分类；
11. 无法取得外部 Provider 时，准确保留阻断，但不能重新实现它们。

只有代码已由 committed/pushed SHA 覆盖后，才创建 v0.3/v0.4 续作分支。


---

# 04 — v0.3 Reference Identity 与 Catalog

## 现有基础

v0.2 已有不可变 `world_reference_identity`。v0.3 不替换它，而是扩展可引用实体种类，
并增加独立的追加式描述和名称模型。

## 目标实体种类

```text
WORLD_OBJECT
SPATIAL_OBJECT
DATA_SCOPE
DATASET
LAYER
LAYER_FEATURE
QUERY_RESULT
DERIVED_REFERENCE
REFERENCE_SET
OPERATIONAL_TASK
```

新增种类通过新 migration 修改约束；不改既有 migration。

## Name/Alias

```text
world_reference_name
world_reference_external_identifier
world_reference_descriptor_version
reference_search_projection
```

名称种类：

```text
CANONICAL_NAME
ALIAS
DISPLAY_LABEL
CODE
EXTERNAL_ID
PINYIN
ABBREVIATION
OPERATOR_LABEL
```

每条名称必须包含：

```text
reference_key
data_scope_key
language_tag
normalized_text
source/evidence
confidence
valid_time
created_at
```

## 解析优先级

```text
Exact ReferenceKey
Exact External ID / Code
Exact Canonical Name
Exact Alias
Normalized/Pinyin
Fuzzy Name
Spatial Context Ranking
```

首版不引入向量数据库。Fuzzy 采用受限 pg_trgm，必须有候选数和相似度阈值。

## 安全

- 所有候选先 Scope 过滤；
- 不返回其他 Scope 的存在性；
- `referenceKey` 不透明；
- 匹配分数不代表当前状态可信度。


---

# 05 — v0.3 Dataset、Layer、Feature Catalog

## 开放目录模型

```text
spatial_dataset
spatial_dataset_version
spatial_layer
spatial_layer_version
spatial_feature_identity
spatial_feature_version
```

Dataset Kind：

```text
VECTOR
RASTER
ELEVATION
NETWORK
POINT_CLOUD
TILESET
CURRENT_PROJECTION
```

v0.3 只要求 VECTOR 和 CURRENT_PROJECTION 真实实现，其他 Kind 只冻结合同。

## Version

每个版本记录：

```text
data_scope
source/source_version
schema_version
CRS
valid_time
quality
lineage
content hash
published/retired time
```

## 与现有 spatial_object 的关系

- 不复制既有 SpatialObject 事实；
- 可通过 binding 将 SpatialObject/Version 注册为 Layer Feature；
- Layer/Feature ReferenceKey 独立于内部 UUID；
- 版本化 Feature 不覆盖历史几何。

## 能力

```text
dataset.get
dataset.list
layer.get
layer.list
layer.find-features
feature.get
```


---

# 06 — v0.3 Reference Capability Provider

新增 Provider：

```text
providerId: gowm.reference-catalog
```

注册：

```text
reference.get
reference.resolve
reference.validate
reference.batch-get
reference.search

dataset.get
dataset.list
layer.get
layer.list
layer.find-features
feature.get
```

## Resolve 输入

WSGS 将来负责 Mention 提取；GOWM 只接收结构化 Mention：

```text
mentionId
surfaceText
expectedKinds
semanticRole
anchorReferenceKeys
mapViewport
limit
```

## Resolve 输出

```text
status
candidate ReferenceDescriptor
matchedBy
matchScore
stateQuality
version
geometrySummary
provenance
```

状态：

```text
RESOLVED_EXACT
SUGGESTED_UNIQUE
AMBIGUOUS
UNRESOLVED
INVALID
```

GOWM 不决定用户是否接受候选，也不返回 `shouldForwardToSdar`。


---

# 07 — DerivedReference、ReferenceSet 与 Result Registry

## Query Result Registry

Gateway 已有 Query/Node/Result 运行记录。v0.3 增加稳定公共结果引用：

```text
world_query_result_reference
world_query_artifact
derived_reference
reference_set
reference_set_member
```

## DerivedReference

必须记录：

```text
sourceQueryId/nodeId
operator
input reference keys
data snapshot hash
compute snapshot hash
method version
geometry/artifact ref
validUntil
revalidationRequired
```

派生引用不自动成为 WorldObject。

## ReferenceSet

- 创建时成员不可变；
- 大集合 Cursor 分页；
- memberCount 与 truncation；
- 集合自身有 ReferenceKey；
- TTL 到期后保留审计记录但拒绝直接用于操作；
- 可通过新查询重新生成。

## 结果验证

```text
result.get
result.validate
reference-set.get-members
```

验证结果：

```text
VALID
STALE
EXPIRED
SNAPSHOT_UNAVAILABLE
REFERENCE_RETIRED
SCOPE_DENIED
```


---

# 08 — World State 与 Evidence 能力

新增或稳定注册：

```text
world.get-current-state
world.get-geometry
world.get-provenance
world.get-observations
world.get-event-timeline
world.get-state-history
```

## 结果必须区分

```text
Current Projection
Observation
WorldEvent
Derived Analysis
Unknown/Conflict
```

## 当前状态

必须返回：

```text
referenceKey
fields
worldVersion
observedAt
receivedAt
freshness
confidence
source observation
provenance
uncertainty
```

## 时间线

- 使用 Cursor；
- 事件稳定排序；
- 迟到事件仍可查询；
- Current Projection 与历史事件不能混为一个列表；
- `NO_DATA` 不输出“对象不存在”或“事件未发生”结论。


---

# 09 — v0.3 Grounding Ready 门禁

GOWM+ 只有满足以下条件才标记 `GROUNDING_READY`：

1. ReferenceKey 合同稳定；
2. Name/Alias/Code 实际可写、可查、可回放；
3. 同名道路返回多个候选而不随机选择；
4. Dataset/Layer/Feature 具有版本和 Scope；
5. Reference Resolve/Validate 通过 Gateway；
6. DerivedReference 和 ReferenceSet 可重放、分页、过期；
7. World State/Geometry/Provenance/Event Timeline 稳定；
8. WSGS 无需访问 Provider URL、数据库或内部 ID；
9. Capability Catalog 可发现所有 Stable/Preview Operation；
10. fresh/upgrade migration 与真实 PostgreSQL 验收通过。


---

# 10 — v0.4 Operational Reality 模型

## 事件源

```text
OperationalTaskEvent (immutable)
        ↓
OperationalTaskSnapshot (rebuildable)
```

禁止直接写 Current Snapshot。

## 四维状态

```text
controlState
activityState
outcomeVerification
observability
```

### Control State

```text
NO_CONTROL_EVENT
REQUESTED_OBSERVED
ACCEPTED_OBSERVED
REJECTED_OBSERVED
COMPLETED_REPORTED
FAILED_REPORTED
CANCELLED_REPORTED
```

### Activity State

```text
NOT_OBSERVED
STARTED_OBSERVED
ACTIVE_OBSERVED
PAUSED_OBSERVED
STOPPED_OBSERVED
UNKNOWN
```

### Outcome Verification

```text
NOT_APPLICABLE
UNVERIFIED
PARTIALLY_VERIFIED
VERIFIED
CONTRADICTED
INDETERMINATE
```

### Observability

```text
FRESH
STALE
OBSERVATION_GAP
NO_DATA
```

四个维度独立投影，不允许压缩为一个 COMPLETED。


---

# 11 — 事件接入与关联传播

## 公共关联字段

```text
executionIntentId
operationCorrelationId
externalPlanningTaskId
externalPlanningStepId
providerActionId
deviceCommandId
```

这些字段从 SDAR→SMPP→Provider→Observation/Event 传播，但在 GOWM 中只形成：

```text
ExternalCorrelationClaim
```

不成为 OperationalTask 主键或状态权威。

## 事件类型

```text
CONTROL_REQUEST_OBSERVED
CONTROL_ACCEPTED_OBSERVED
CONTROL_REJECTED_OBSERVED
EXECUTION_STARTED_OBSERVED
EXECUTION_PROGRESS_OBSERVED
EXECUTION_PAUSED_OBSERVED
EXECUTION_STOPPED_OBSERVED
CONTROL_COMPLETED_REPORTED
PHYSICAL_EFFECT_PARTIALLY_CONFIRMED
PHYSICAL_EFFECT_CONFIRMED
PHYSICAL_EFFECT_CONTRADICTED
EXECUTION_FAILED_OBSERVED
EXECUTION_CANCELLED_OBSERVED
OBSERVATION_GAP_OPENED
OBSERVATION_GAP_CLOSED
```

## Ingest

- 事件必须有稳定 ID；
- 重试不得换 ID；
- `eventTime` 与 `receivedTime` 分离；
- Future/late/out-of-order 受版本化策略处理；
- 原始 Observation/Event 不可变；
- Projection 失败不得部分更新 Current Snapshot。


---

# 12 — OperationalTask Projection

## 身份形成

优先级：

```text
明确 operationCorrelationId
明确 providerAction/deviceCommand
人工确认的执行 Episode
受限推导 Candidate
```

仅凭时间和位置相似度不得自动创建 CONFIRMED OperationalTask；只能生成候选关联。

## 投影规则

- 每次 Event 先持久化；
- Subject/OperationalTask 行锁；
- 依据 eventTime、source priority、confidence、eventId 稳定排序；
- 迟到事件可进入历史，但不能回退较新 Current；
- 终态报告与物理验证维度独立；
- 每次 Current 变更产生投影事件和 worldVersion；
- Snapshot 可由事件全量重建并比较 Hash。

## Current 输出

```text
operationalTask ReferenceKey
actor/target ReferenceKeys
four state dimensions
first/last observed time
freshness
evidence IDs
correlation claim summary
projection policy version
worldVersion
```


---

# 13 — Correlation Resolution

## 输入

```text
ExternalCorrelationHint
Resource/Actor Reference
Time Window
Spatial Context
Provider Action/Command
```

## 关系

```text
REPORTS_EXECUTION_OF
REALIZES
PARTIALLY_REALIZES
POSSIBLY_CORRESPONDS_TO
NO_MATCH_FOUND
CONFLICTING_MATCHES
```

## Match Basis

```text
PROPAGATED_CORRELATION_ID
PROVIDER_DECLARED
MANUAL_CONFIRMATION
RESOURCE_AND_TIME_MATCH
SPATIOTEMPORAL_INFERENCE
```

可靠性顺序必须显式；推导匹配不能覆盖明确 ID 冲突。

## 结果

CorrelationFinding 是追加式分析结果：

```text
candidate operational task/events
basis
confidence
supporting/contradicting evidence
worldVersion
methodVersion
```

不得修改 SDAR 或 OperationalTask 身份。


---

# 14 — External Predicate Evaluation

External Predicate 来自外部计划或查询，是只读验证输入。

首版 Operator：

```text
IS_INSIDE
IS_NEAR
INTERSECTS
HAS_REACHED
HAS_STOPPED
HAS_OBSERVED
EVENT_OCCURRED
STATE_EQUALS
```

输出：

```text
SUPPORTED
NOT_SUPPORTED
PARTIALLY_SUPPORTED
INDETERMINATE
NO_DATA
CONFLICTING
```

## NOT_SUPPORTED 门槛

仅当：

```text
时间窗有效
观测覆盖充分
关键传感器/数据源健康
存在明确相反证据
```

否则返回 `INDETERMINATE` 或 `NO_DATA`。

## 执行

Predicate Provider 可以通过 Gateway DAG 组合：

```text
world.get-current-state
spatial.*
stas.*
world-event.*
observability.evaluate
```

但 Provider 之间仍不直接互调。


---

# 15 — Observability 与负面证据

## 目标

区分：

```text
没有观测数据
观测存在空档
数据陈旧
覆盖充分但没有目标
存在明确反证
```

## ObservabilityAssessment

输入：

```text
subject/reference set
time window
expected sources/sensors
coverage geometry
freshness SLA
```

输出：

```text
FRESH
STALE
OBSERVATION_GAP
NO_DATA
COVERAGE_SUFFICIENT
COVERAGE_INSUFFICIENT
SOURCE_UNHEALTHY
```

并携带：

```text
coverage evidence
source health
watermark
last reliable observation
gap intervals
assessment policy version
```

首版可以基于现有 Sensor Coverage、Watermark、Gap 和配置策略，不要求完整传感器仿真。


---

# 16 — v0.4 Gateway Provider 集成

新增 Provider：

```text
gowm.operational-reality
```

注册：

```text
operational-task.find
operational-task.get
operational-task.get-timeline
operational-task.find-by-correlation

world-event.find-by-correlation
world-event.get-timeline

correlation.resolve
predicate.evaluate
observability.evaluate
```

另稳定：

```text
gowm.reference-catalog
gowm.dataset-catalog
gowm.world-evidence
```

所有 Operation 具有：

```text
operation version
schema hash
scope policy
snapshot policy
cost class
limits
maturity
```

Gateway 不理解四维投影算法，只负责路由和编排。


---

# 17 — 数据库迁移与只读合同

实际 migration 编号以执行时最新仓库为准。建议逻辑顺序：

```text
reference identity kind extension
reference names/identifiers/descriptors
dataset/layer/feature catalog
reference search projection
query result/derived reference/reference set
operational task events/current projection
correlation claims/findings
predicate evaluations/observability assessments
read contracts and service roles
```

## 只读合同

```text
gowm_reference_v1
gowm_catalog_v1
gowm_world_evidence_v1
gowm_operational_reality_v1
```

Provider 只读这些合同；无 Base Table 权限。

## 迁移验收

- 001–014 Hash 不变；
- fresh install；
- 从 v0.1 升级；
- 从 v0.2 升级；
- 重复执行；
- 回滚故障事务；
- 数据和 ReferenceKey 保留；
- Scope 和角色权限实际验证。


---

# 18 — Security、Scope、Replay

## Scope

- 所有表含 DataScope；
- Gateway 传递签名 Scope；
- Provider 设置事务级 Scope；
- SQL Contract 再次过滤；
- 跨 Scope ReferenceKey 返回不可区分拒绝；
- 搜索结果不得泄露候选计数。

## Replay

必须支持：

```text
Reference Search Projection 重建
OperationalTask Snapshot 重建
Correlation Finding 重算
Predicate Evaluation 按冻结输入重放
```

重放必须记录：

```text
policy version
source event range
input/evidence hash
output checksum
difference report
```

## Security

- bounded text/name/alias；
- pg_trgm 候选上限；
- JSON 深度和大小；
- Cursor 签名；
- no arbitrary SQL/URL/tool；
- error/audit/trace 脱敏；
- immutable result/evidence records；
- late result 不覆盖 cancelled/expired result。


---

# 19 — 兼容与版本策略

## 合同

稳定后冻结：

```text
gowm-reference/1.0
gowm-dataset-catalog/1.0
gowm-world-evidence/1.0
gowm-operational-task/1.0
gowm-correlation-finding/1.0
gowm-predicate-evaluation/1.0
```

同 Major：

- 只增加可选字段；
- 不改单位和语义；
- 不删除 Enum 值；
- 未知可选字段客户端可忽略；
- 未知 Major fail closed。

## 兼容 API

旧 World/Spatial/Situation API 可保留 Adapter，但新 Reference/Operational Reality 的规范入口为 Gateway Operation。

## 数据兼容

- ReferenceKey 永不复用；
- 名称删除使用 valid_to/retirement event；
- OperationalTask Event 永不更新；
- Current Projection 可重建；
- Result TTL 过期不删除审计记录。


---

# 20 — 实施阶段

每个阶段必须：实现、实际测试、报告、semantic commit、push、PR 更新。

## C00 Source Reconciliation
对账 `codex/gowm-capability-platform-v0.2`、PR #1、实际 Head、工作树和旧状态文件。

## C01 v0.2 Commit/Report Closure
确保当前实现被 committed/pushed SHA 覆盖，修正陈旧 Git 状态。

## C02 v0.2 Real Runtime Closure
运行 PostgreSQL/Provider/Docker/DAG/Scope/Restart 门禁；无法运行则保留真实阻断。

## C03 Stacked Branch
从准确 v0.2 candidate 创建 `codex/gowm-grounding-operational-v0.4-stable` 和 stacked Draft PR。

## G00 v0.3 Contracts/ADR
冻结 Reference、Catalog、Derived Result 合同和 Provider Manifest。

## G01 Reference Identity Evolution
扩展 entity kind，增加 Descriptor/Name/External ID。

## G02 Dataset/Layer/Feature Catalog
实现版本化 Catalog、Binding 和 Scope。

## G03 Reference Search Projection
精确/别名/拼音/pg_trgm，重建和 Candidate Budget。

## G04 Reference Provider
实现 reference/dataset/layer/feature Gateway Operation。

## G05 Derived Result Registry
实现 ResultReference、DerivedReference、ReferenceSet、TTL、Cursor。

## G06 World Evidence Provider
状态、几何、来源、Observation、Event Timeline。

## G07 v0.3 Security/Replay
Scope 对抗、Search Projection 重建、迁移和恢复。

## G08 Grounding Ready Acceptance
真实 Gateway E2E；标记 `GROUNDING_READY`。

## O00 v0.4 Contracts/ADR
冻结 OperationalTaskEvent/Snapshot、Correlation、Predicate、Observability。

## O01 Correlation Metadata Ingest
Observation/Event 关联字段和 Claim 落库。

## O02 Operational Event Store
不可变事件、去重、晚到、Scope、Outbox。

## O03 Operational Projection
四维状态和重建。

## O04 Correlation Index/Resolver
显式 ID 与受限推导匹配。

## O05 Timeline/Query Provider
OperationalTask/Event 查询能力。

## O06 Predicate Evaluation
首批 Predicate Operator 和 Evidence。

## O07 Observability
Coverage/Watermark/Gap/Source health。

## O08 Correlation Findings
追加式 Findings、冲突、不匹配和重放。

## O09 Operational Reality Provider
全部 Operation 注册到 Gateway。

## O10 Operational Reality Acceptance
真实事件→Snapshot→Correlation→Predicate E2E。

## S00 Contract Compatibility
Schema Hash、v1 兼容、Operation v1/v2。

## S01 Migration/Replay
fresh、v0.1→v0.4、v0.2→v0.4、重建校验。

## S02 Security/Load/Recovery
Scope、并发、迟到、重启、幂等、候选和时间线性能。

## S03 Documentation/Version
更新 VERSION/README/CHANGELOG/PROJECT_STATUS/Runbook。

## S04 Final Stable Candidate
完整 Required Matrix、exact local/remote SHA、PR Ready；不 merge/tag/release/deploy。


---

# 21 — 测试与验收

完整矩阵位于 `acceptance/acceptance-matrix.csv`。

测试层级：

```text
Unit
Contract
SQL AST
PostgreSQL Integration
Projection Replay
Gateway/Provider Contract
Real Container E2E
Scope Adversarial
Migration Upgrade
Load/Recovery
```

必须真实证明：

- v0.2 代码和远端 SHA 对账；
- Reference 名称/别名/同名歧义；
- Layer/Feature 版本；
- DerivedReference/ReferenceSet TTL；
- OperationalTask 四维状态；
- Provider completed + physical unverified；
- 迟到事件不回退；
- NO_DATA 与 NOT_SUPPORTED；
- exact correlation 与 conflicting matches；
- fresh/upgrade/replay；
- Gateway/Provider/DB restart；
- 跨 Scope 无泄漏。


---

# 22 — Git、PR 与交付

## v0.2

继续使用：

```text
branch: codex/gowm-capability-platform-v0.2
PR: #1
```

仅完成对账、真实门禁和必要修复，不把 v0.3/v0.4 混入旧 PR。

## v0.3/v0.4

```text
branch: codex/gowm-grounding-operational-v0.4-stable
initial base: codex/gowm-capability-platform-v0.2
PR title: feat: add GOWM grounding and operational reality v0.4
```

如果用户合并 v0.2，允许通过 GitHub 更新 Base，不重写提交。

## 报告

```text
execplans/EP-gowm-grounding-operational-v0.4.md
reports/gowm-v0.4/sync-state.json
reports/gowm-v0.4/<phase>-completion.md
reports/gowm-v0.4/<phase>-acceptance.json
reports/gowm-v0.4/final-stable-candidate.md
```

## 禁止

- 自动 merge；
- Tag/Release；
- 生产部署；
- force-push/rebase 已发布历史；
- 覆盖其他任务工作树；
- 提交密钥和真实敏感数据；
- 修改 WSGS/SACS/SDAR/SMPP 仓库。


---

# 23 — 最终稳定候选标准

只有全部满足，才能把软件版本设为 `0.4.0` 并输出完成标志：

## v0.2 基础

- Capability Platform 实现有准确 committed/pushed SHA；
- 真实运行门禁通过或所有 Required 环境已经补齐；
- Gateway/Provider/DAG/Scope/Restart 稳定。

## v0.3

- Reference/Catalog 公共合同 v1；
- 同名歧义、Scope、版本、TTL、重放；
- Gateway Operation 真实通过；
- `GROUNDING_READY`。

## v0.4

- OperationalTaskEvent/Snapshot；
- 四维状态；
- Correlation Claim/Finding；
- Predicate Evaluation；
- Observability；
- 迟到事件、冲突、重建；
- `OPERATIONAL_REALITY_READY`。

## 稳定性

- fresh 和两条升级路径；
- 无 Required 失败/未声明跳过；
- exact local/remote SHA；
- Draft PR 转 Ready；
- merge/tag/release/deploy 仍由用户控制。


---

# v0.2 external runtime prerequisites

The v0.3/v0.4 package does not redistribute the prior CRS and Geometry POC
sources. To close outstanding v0.2 real-runtime gates, Codex may use the
previous GOWM+ Capability Platform v0.2 task package inputs or operator-provided
immutable equivalents.

Locked prior inputs:

```text
CRS ZIP SHA-256:
3110e7b344d138908d27e759ede70701b8a20dd7bbbd9795b3a57d02b8d70995

Geometry ZIP SHA-256:
3527a06d7a6216c1bf1c2ee75690824298231917c03a8c99507a71df26f12c3d

Spatial ZIP SHA-256:
15cdaf00f3c5ee911eac1351c2d9a59ff06a5de93a176ce81b644b19ee5de322

H3 Toolkit:
zhouwen-giser/h3-spatial-toolkit@
74fc8657072dd58a2f8e4317c1caef8bfd10e024
```

If these inputs or a clean runtime are unavailable, complete all code and
controlled tests, record the exact external blocker, and do not claim real
runtime acceptance.

# GOWM 设备中心化共享业务存储 v0.2

完整 Codex Goal 实施任务书 · 2026-09-08

只改 GOWM；固定共享 ugv_smpp / ugv_sdar；通过 device_id 归属业务；先实现存储再分仓适配。

# G00 — 目标、来源与单仓边界

## 目标

在 `zhouwen-giser/geospatial-operational-world-model` 实际实现设备中心化共享业务存储。GOWM 管设备主档和数据库；所有 UGV 共用 `ugv_smpp` 与 `ugv_sdar` 两个固定业务 Schema，业务记录通过 `device_id` 归属设备，通过明确的 Task / Step Run / MCP Task / Execution / Mission 身份形成关联。

本任务不是设计文档任务。必须交付正式迁移、可重复安装器、源结构适配、数据访问实现、双设备测试和后续消费者接入合同。

**仅修改 GOWM 仓库。** SMPP、SDAR、GDPS、WSGS、SACS、分析 Provider 仓库只读；不提交跨仓修改、不启动设备控制、不迁移现有运行数据。

本任务版本 `v0.2` 是对旧设备业务库草案的设计修订，不要求把 GOWM 软件版本改成 0.2，也不默认升级 GOWM 根 package version。

## 权威优先级

1. 用户最新决策：固定共享业务域、device_id 隔离、禁止每实例建库。
2. 本任务包的目标和数据合同。
3. 执行时读取的当前仓库实际类型、迁移与业务语义。
4. 旧 v0.1 设计仅供理解，不作为可执行输入。

旧文件：
- GOWM_Device_Business_Storage_v0.1_Design_CN.md
- GOWM_Device_Business_Storage_v0.1_design.sql

其中 `business_store`、`device_runtime_binding` 的实例存储绑定、动态实例 Schema、`*_store_id` 跨库关联被本任务取代。不得直接执行旧 SQL。

如果本地没有旧文件，不影响执行；本包已完整说明替代内容。若旧草案已进 Git，只修改草案或新增更正，不覆盖已经执行过的迁移，不 DROP 现有有数据的表。

## 仓库和观测基线

本包于 2026-09-08 读取：
- GOWM main: dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838
- SMPP main: b974471dd62665721a5edcc63b7651d2f476160d
- SDAR main: cb50da8ec8d160a673852be8bcdfc3bb094f5ce5

这些 SHA 是来源记录，不是执行门禁。开始先阅读 AGENTS.md，再 fetch 当前远端。GOWM 从最新可用主线或已有明确相关开发分支创建：
`codex/gowm-device-shared-business-storage-v0.2`

不为了追逐 SHA 反复重跑测试；报告本次实际基线即可。不得改写他人的工作区、强推、自动合并、打 Tag 或发布。

## 必须先做的源码盘点

GOWM：
- world_object / data_scope / world_reference_identity
- source_registry / producer_pipeline / datastream
- world_observation / measurement / entity_binding
- ugv_ingest 全部表与当前 Mapper 身份逻辑
- scripts/migrate.ts、SQL验证器、版本/迁移冻结检查

SMPP：
- migrations/runtime、migrations/providers/ugv 的当前完整集合
- Migration Resolver 与 Runtime/Provider安装入口
- persistence-postgres、UGV store 实际 SQL
- Task领取、Idempotency、命令Claim、Lease、Snapshot、Cursor、TTL/Purge路径

SDAR：
- 当前运行库 baseline 和实际后续增量入口
- agent_task、Goal/Plan、Workflow/Node Run、mcp_invocation、remote_task_binding
- Repository事务边界、schema-qualified SQL、vector依赖
- 不纳入独立 Node Control 管理库，除非某项已证明为运行库不可分依赖

产出 `source-inventory.json` 和 `repository-adaptation-matrix.md`。每个有关的源表/字段应记录真实路径、身份键、设备归属方式、是否修改以及验证方法。不要把任务包中建议的原生表名当作未经核实的事实。

## 两个明确边界

存储统一 ≠ 执行引擎统一。SDAR 仍经 MCP 调 SMPP，SMPP/Provider 仍经原协议派发设备。
同库 ≠ 跨服务原子提交。不得把设备网络调用放入数据库事务，也不得宣称一次数据库提交保证物理 exactly-once。


---

# G01 — 架构和已确定的决策

## 固定布局

使用现有 GOWM PostgreSQL database，不改数据库名称，不新增按设备或实例命名的 database。

```
现有 GOWM database
├─ public / 已有GOWM Schema       保持
├─ ugv_ingest                      保持
├─ gowm_device                    4张公共业务表
├─ gowm_task                      2张公共业务表
├─ gowm_execution                 3张公共业务表
├─ ugv_smpp                       Runtime与UGV Provider共用固定Schema
├─ ugv_sdar                       全部UGV的SDAR运行业务共用固定Schema
└─ gowm_business_v1               固定只读视图与查询
```

`ugv_smpp` 内仍区分 Runtime 和 Provider 的逻辑写入责任与迁移 family，不合并它们的状态机。不同应用对象若真实同名，生成一个明确、固定的域前缀映射；禁止引入实例后缀回避冲突。

运行进程增加、重启、重部署不建新表，也不产生新 storeId。将来其他设备类型可增加适配，不在本任务创建 UAV 专用业务库。

## 一份记录

SDAR Task/Plan/Workflow 使用 ugv_sdar 中的原生记录。
MCP Task、Execution、Dispatch 使用 ugv_smpp 中的原生记录。
公共表保存设备、目标和关联，不再复制一份 Task/MCP状态摘要。
公共视图直接 JOIN 原表，不使用周期导出、CDC、跨库复制、FDW或物化副本作为主链路。

## 设备身份

- device.device_id 复用真实 world_object.id；不使用展示名称替代。
- device_identifier=ugv1 是外部标识，不保证等于 device_id。
- 沿用既有 data_scope，防止不同环境数据串联；不新增租户系统。
- 设备身份列在根业务记录创建时明确落库。
- 修改设备服务绑定、名称和连接地址不改变旧任务 device_id。
- 当前Scope已有全局唯一 world_object.id 时不再生成另一套设备UUID。

## 三种键不能混用

1. device_id：业务归属。
2. sdar_service_key / smpp_service_key / source_system_key：稳定逻辑服务或外部来源范围。
3. worker_id / lease owner / process instance：当前处理者。

服务逻辑键不是数据库命名依据。禁止将进程随机ID用于Task和Mission的稳定身份。
全局模板/操作定义可不带device_id；设备状态、设备游标和设备任务必须有设备范围或明确父记录。

## ID策略

- 新建的内部 Task / Invocation / Execution 身份在共享业务域内唯一，优先保留现有全局UUID/ULID机制，不批量改变无问题的主键类型。
- 对真实设备/来源本地计数，使用设备+来源范围的复合键，不假装其全局唯一。
- 跨设备出现相同原生 mission_id、snapshot revision、idempotency text 不得串数据。
- 引用子表若重复保存device_id，使用同设备复合FK或同事务校验，防止A设备子记录指向B设备父记录。
- 旧数据搬迁不在本任务；源本地ID可保留来源命名空间，但不能成为实例专属Schema的借口。

## 运行实例管理

不新增运行实例管理中心、不新增 business_store、不新增设备到物理库位置的绑定。
worker领取任务时使用显式 allowedDeviceIds/deviceId，并保留现有claim/lease语义。
固定Schema的安装版本放在migration history/contract manifest，不能要求每台设备登记一套版本。

## 本任务不做

不接真实MQTT、不启动设备任务、不改SDAR/SMPP运行应用；不计算覆盖、可视域或任务达成；不扩展WSGS/SACS；不增加HTTP SQL网关、MCP数据库工具、管理UI、自动部署、分库分表、分区、HA、负载认证、强制RLS或新鉴权平台。

RLS并非当前验收前置。保留既有Scope/权限机制，新增功能只承担基本的数据范围正确性，不藉此弱化现有机制。


---

# G02 — 四张设备公共表与管理访问

最终必须有以下4张公共表。若执行时已有等价表，应最小扩展并在合同中固定真实表名，不并行创建第二套设备目录。

## 1. gowm_device.device

字段：
- device_id text PK，关联既有world_object.id。
- data_scope_key text NOT NULL，复合FK(data_scope_key,device_id)→world_object(data_scope_key,id)。
- identifier_namespace text、device_identifier text、device_name text、device_type text，均非空。
- enabled boolean default true。
- properties jsonb object；created_at / updated_at timestamptz。

约束：
- UNIQUE(data_scope_key,identifier_namespace,device_identifier)。
- UNIQUE(data_scope_key,device_id)供其他表校验Scope。
- 不保存另一份当前位置、电量或运行状态；enabled不是在线状态。
- 不在device表放密码或整个运行配置。
- 改名不换ID。既有Reference名称投影使用现有入口，不写出假ReferenceKey。

登记函数/Repository支持：对已存在world object登记设备；明确创建新设备时通过已有世界对象流程创建后登记。
已有ugv1优先查找实际对象；多个候选时不自动合并。Fixture可明确创建两台模拟设备，不冒充真实设备。

## 2. gowm_device.mqtt_endpoint

endpoint_id uuid PK、endpoint_key text UNIQUE、broker_url text、client_id_prefix text、
credential_ref text NULL、connection_options jsonb object、enabled、created_at/updated_at。

协议允许mqtt/mqtts/ws/wss。只保留凭据引用；该表不承担密钥库职责。
一个endpoint可以供多台设备复用。实际采集进程必须使用唯一完整Client ID，不能把同一prefix直接作为所有连接Client ID。
此任务只登记/查询配置，不发起网络连接或替换现有采集服务。

## 3. gowm_device.device_stream

stream_id uuid PK、data_scope_key、device_id、endpoint_id、stream_key、topic_filter、
identity_mode、identity_rule jsonb、message_profile、mapper_config jsonb、
datastream_key、qos smallint、enabled、created_at/updated_at。

identity_mode：
- BOUND_DEVICE：整条订阅显式归属一台设备。
- TOPIC：topic片段/匹配规则带设备标识。
- PAYLOAD：payload明确字段带设备标识。

规则：
- UNIQUE(device_id,endpoint_id,stream_key)。
- 设备与canonical datastream的Scope一致；复用source_registry/pipeline/datastream。
- 保留当前MQTT会话Mapper上下文，不能拿新配置重解释旧消息。
- 提供纯函数或Repository级 `resolveIngestDevice`，输入endpoint/topic/decoded payload，输出唯一device或NO_MATCH/AMBIGUOUS。
- 不实现任意脚本执行。身份规则采用小型显式字段/Topic片段配置。
- BOUND_DEVICE相同/重叠Topic不能同时归属两台设备；单纯唯一索引无法识别通配符重叠，配置/路由解析需检测。
- PAYLOAD/Topic合法区分的共享订阅允许存在；两个配置同时命中同一设备可去重，命中不同设备必须报歧义。
- 不匹配消息不得默认写ugv1。
- “观测subject是目标对象”与“observer/device是本车”保持区别。

## 4. gowm_device.device_service_binding

取代旧device_runtime_binding，不含任何storeId/schemaName/数据库地址。

字段：
- binding_id uuid PK、data_scope_key、device_id、binding_role（首版PRIMARY）。
- smpp_service_key text；provider_id text；resource_id text。
- sdar_service_key text NULL；agent_profile_id text NULL；sdar_mcp_server_id text NULL。
- valid_from timestamptz；valid_to timestamptz NULL；created_at。
- 所有服务键表示稳定逻辑入口，不是每次重启变化的进程ID。

约束：
- 一个设备/role最多一个当前有效绑定。
- 同一(smpp_service_key,provider_id,resource_id)当前只能对应一个device。
- 可先登记SMPP部分，SDAR字段随后补为新绑定版本。
- 一个(sdar_service_key,sdar_mcp_server_id)可用于多台车，但必须对应同一明确smpp_service_key；不能把该二元组设为设备独占。
- valid_to > valid_from；首版登记立即生效，不建设未来调度系统。
- 设备或路由身份变化时关闭旧绑定并新增；不原地改写已被业务记录引用的身份字段。
- 注册/关闭同一设备绑定使用同事务锁或约束处理并发，普通rename/地址更新不重分配历史。

历史Task/Execution保存device_id及当时binding_id；当前绑定不是历史归属推断器。

## 访问实现

在GOWM内提供小型Typed Repository/CLI：
registerDevice、upsertMqttEndpoint、registerDeviceStream、replaceDeviceServiceBinding、listDeviceConfig、resolveIngestDevice。
上述是建议函数名，不新增远程管理平台。测试使用同一生产Repository，不在测试中复制实现。

新增表的基础FK、JSON object、非空、唯一约束应真正落在DDL中。跨表动态业务检查使用短小写入函数/Repository及测试，不只写成COMMENT。


---

# G03 — 固定共享业务库的实际安装

## 安装范围与关系

固定 `ugv_smpp` 同时承载SMPP Runtime和UGV Provider原生业务表；固定 `ugv_sdar` 承载SDAR运行库原生记录及其不可分依赖。
这里“原生”指保留业务字段与状态语义，不意味着旧二进制可无修改连接共享库。共享设备键和约束是本任务必须产生的存储侧变更，应用接线随后各仓库独立实施。

不得只建空Schema，或手写Task/Mission三张简化表后声称完成。
不得把原生库放到另一个database，再通过视图/FDW/同步器拼回来。
不得在GOWM创建Task、Plan、MCP Task的第二份影子表。

## SMPP Runtime

从当前安装入口取完整runtime migration family，不只重放002文件。
公共读取重点：
- operation_snapshot
- provider_task
- admission_intent
- task_observation
- task_input_request
- idempotency_record
- command dispatch / control
- outbox / inbox
- 运行恢复、timing、lease及当前实际依赖

只读核实PMS配置或其他表是否为真实执行依赖；独立PMS管理数据库、其他设备Provider、诊断平台不扩大搬迁。
遇到名字相同的表/类型/索引，先核对语义。不同family共享ugv_smpp时必须消除实际命名冲突，但保持一个固定Schema；转换映射写入manifest。

## UGV Provider

安装当前provider:ugv完整依赖，至少涵盖：
ugv_execution、ugv_execution_command_ack、ugv_mutation_journal、
ugv_device_tool_call、ugv_state_snapshot、ugv_business_event_source_state/log。

Task、Execution、Dispatch完整arguments/context/result/payload保留。
不要只保留Hash，不能把源业务字段扁平化后丢弃实际请求。
原生downstream_mission_ids只作Execution汇总，不可替代逐派发Mission关联。

## SDAR

遵循当前真实安装入口选取“baseline + 未被baseline覆盖的增量”。
不得“baseline + 所有历史up.sql”重复安装；不得应用down.sql。
实际依赖包括Task/Goal/Plan/Workflow/Node/Skill输入、Invocation、Remote Task Binding及必要结果/证据/事务表。
共享知识、Skill、Workflow模板等是业务域级记录，不按device复制。
如果整个当前运行库为启动/事务所必需，应安装其当前依赖闭包，不另造缩水版。
不搭建独立Node Control管理系统，不搬迁聊天UI或其他系统。

## 源码托管与安装转换

GOWM新增：
```
database/shared-business-storage/
├─ sources.json
├─ upstream/
│  ├─ smpp-runtime/
│  ├─ ugv-provider/
│  └─ sdar-runtime/
├─ transforms/                 明确、可追踪的托管安装变换
├─ generated/
│  ├─ ugv_smpp/
│  └─ ugv_sdar/
├─ overlays/                   device scope / FK / indexes / key changes
└─ install-manifest.json
```

保留来源commit、完整原文件路径、规范化换行前后Hash定义；生成物记录每项变换。不要嵌入所有上游项目源代码。
禁止启动时联网“拉最新SQL”。Codex实施时对账一次后生成当前可重复安装包；后续升级再显式更新。

SDAR已知baseline含public.*、set_config(search_path,'')、函数、序列和vector。
转换必须按对象清单处理：
- 应用表/函数/序列/外键/默认值进入ugv_sdar。
- 扩展仍在既有受管理扩展Schema，不搬移或伪造vector/PostGIS。
- 函数体中未限定的应用表引用必须绑定正确Schema。
- 修正会覆盖安装连接search_path的语句。
- 支持当前实际PostgreSQL版本，不强制升级到最新；处理dump中的版本专用SET选项时记录为何可安全忽略。
禁止全文件简单replace("public.","ugv_sdar.")，它会误处理扩展对象且遗漏动态SQL。
源DO块/函数体内对象引用也必须验证；仅AST解析通过不等于正确安装。

## 迁移记账

1. GOWM公共9张表用下一可用core迁移；不写死076、不得重写旧001–075或当前更长历史。
2. 原生托管迁移使用独立安装入口，不塞进core数字序列。
3. ugv_smpp中迁移family分别为SMPP_RUNTIME和UGV_PROVIDER；版本身份为family+完整源文件名。
4. 保留源应用自身marker需要时的等价含义，不能让其与public.schema_migration互相误用。
5. 当前SMPP已知有两份合法014源文件，不能仅用数字编号去重。
6. 安装器拥有托管结构升级责任，应用后续以verify-only/migration-disabled模式接入。
7. 固定Schema安装一次；第三台设备加入只加数据，migration count不变。
8. 重复安装同一内容返回ALREADY_APPLIED；内容不同但同身份必须报错，不静默跳过。
9. 每个阶段的DDL与自身history写入事务化；原生SQL自带BEGIN/COMMIT时先生成清晰事务边界，不使用无效嵌套事务伪称原子。
10. 使用一个固定安装锁避免两个安装器并发冲突；这不是逐实例业务库管理。

## 依赖与既有GOWM隔离

基础依赖以现有GOWM为准。SDAR vector不可用时应报告准确依赖缺口，不删掉向量表、降级成JSON或假PASS。
core公共表与ugv_smpp可独立完成安装；ugv_sdar依赖失败不会导致已有GOWM服务/采集失效。
全套最终storage-ready需要SDAR安装及读写实测完成。

不得通过关闭约束、复制空表、禁用已有测试或临时表替代真实依赖。
安装连接的search_path与DDL显式限定相互一致；不能更改全数据库或所有角色的默认search_path。
extensions只在明确需要时安装，不移动/删除既有扩展，不修改旧业务数据。


---

# G04 — 共享业务库的设备范围、键和并发

这是功能正确性工作，不是新安全平台。目标是两台设备真正共用同一套表，不串任务、快照或幂等结果。

## A. 根记录与设备归属

ugv_smpp.provider_task：
- device_id：托管UGV设备任务必须明确填写，无默认ugv1。
- gowm_binding_id：冻结当时绑定。
- smpp_service_key：需要保留逻辑来源范围时写入；不能用process ID。
- 建立(device_id,task_id)可引用唯一键，设备/绑定一致性FK。
- task_id沿用当前全局唯一UUID；不因设备变化换ID。

ugv_smpp.ugv_execution：
- device_id、gowm_binding_id、稳定provider来源键（若当前字段不足）。
- 保留原task_id/外部execution identity；明确它与MCP Task的真实对应，不凭同名列JOIN。
- 对设备本地external_execution_id重设为(device_id,稳定来源,external_execution_id)唯一；若源生成器已保证全局唯一，记录证据并保留主键，但源本地别名仍需设备范围。

ugv_sdar.agent_task：
- device_id、gowm_binding_id、sdar_service_key（稳定逻辑来源）。
- 非设备Task可为空，设备业务Repository必须拒绝漏传device_id；不得用进程配置自动补成ugv1。
- 公共设备查询只返回明确设备记录，NULL不等于所有设备。

ugv_sdar.remote_task_binding：
- 明确device_id（或通过强父级关系确定）、smpp_service_key、可验证的canonical MCP Task身份。
- 删除旧smpp_store_id方案。
- server_id是外部/配置别名，不能单独当成全局Runtime身份。
- 异步接纳时上游/下游记录可能尚未全部存在：显式未解析，不制造ID或硬加不可能满足的提前外键。

## B. 每张表必须归入一种范围

source-inventory中的每个表：
- DEVICE_ROOT：直接device_id。
- DEVICE_CHILD：由明确FK父级确定；独立领取/读取需要时加device_id。
- DEVICE_CHANNEL：快照、游标等以device_id+source/channel/session定位。
- BUSINESS_GLOBAL：公共Skill、operation定义、固定库安装记录等。
- WORKER_EPHEMERAL：owner/lease等处理者信息，不是业务归属。

全局表不得强行绑定ugv1；设备专属表不得省略范围。没有理由的UNKNOWN分类不得进入完成报告。

## C. Idempotency

核查admission、idempotency record/claim、response inbox及创建调用所有唯一键。
设备操作的幂等空间至少包含：
device_id + 稳定操作来源/Provider范围 + 原有调用者授权范围 + operation + idempotency_key + execution mode。
不同设备同文本幂等键应独立；同设备同操作重发应命中同一记录；同一幂等身份不同实际参数应报冲突。
不能仅把device_id加列，保留原跨设备唯一键使第二台车仍冲突。
不同服务键不是必须出现在每个索引；逐项以实际生成器与执行语义决定并写明，不机械膨胀所有键。

## D. Snapshot / Cursor / Revision

当前ugv_state_snapshot初始主键为revision；共享设计必须消除“所有设备同revision冲突”。
建议键：(device_id,source_session_key,revision)，或全局snapshot_id +上述源唯一键。
来源session必须实际取得；没有session时使用明确稳定的源实例范围，不默认任意'unknown'作为真实设备会话。
读取最新状态必须WHERE device_id=...并限定相应source/channel，不能全表ORDER BY observed_at LIMIT 1。
latest_snapshot_revision的关联查询需要同设备/来源；不能只按revision JOIN。
业务事件stream、mapper cursor、provider缓存key同样检查设备范围。
状态缓存的“最新”按现有状态语义，不把received_at冒充设备观测时间。

## E. 任务领取、恢复与所有者

GOWM提供可测试的数据访问函数/Repository样例，不重写SMPP或SDAR调度引擎。
接口要求明确allowedDeviceIds/deviceId；缺失时返回参数错误，不扫描所有设备。
领取流程沿用现有可运行状态筛选与claim机制；FOR UPDATE SKIP LOCKED只解决竞争，不解决设备路由。
两个Worker负责同一设备时不得同时领取同一执行；Worker A仅负责设备A时不得领取B。
恢复任务、补发outbox、处理响应inbox、TTL扫描等也按其负责的设备/业务范围执行。

Lease标识必须区分：
- DEVICE / TASK级资源：包含设备或全局Task身份。
- SERVICE级公共工作：稳定service/job范围。
- Worker owner：可变处理者。
同一受保护资源的竞争者必须争用同一个lease key；不能把workerId加入lease key让每个Worker各拿一把锁。
新增示范claim函数只用于证明存储接口，并在后续手册映射到当前claim代码；不要创建第二个生产任务状态机。

## F. 两个设备不能共享一个可变“本车上下文”

核查singleton、latest、provider revision、active operation索引、固定sourceId、client/session等所有隐式单实例假设。
每项给出：
源路径；现有约束；共享后范围；GOWM DDL/查询改动；后续应用改动；测试编号。
把进程配置硬编码的resource/adapter URL改造留给SMPP任务，但此处必须在交接中指出，不宣称表共享即运行支持多设备。
与设备无关的配置singleton保持业务全局，不无谓复制。

## G. TTL / 删除

Task句柄过期仍按源协议表达；不能自动删除用于任务历史的Task、Dispatch、Mission Link。
保留协议过期字段，GOWM默认角色不执行业务历史清理；提供明确retention合同。
不得偷偷用trigger忽略DELETE，让旧清理器以为已删除。
后续SMPP必须适配purge路径才能上线；本轮用测试证明句柄过期标记不使JOIN历史消失。


---

# G05 — 目标图形：两张公共表

## gowm_task.target_geometry

- target_id uuid PK：精确目标修订。
- target_group_id uuid；revision int>0；UNIQUE(target_group_id,revision)。
- data_scope_key FK。
- source_domain：SDAR / SMPP / UGV_PROVIDER / GOWM_USER；不保存storeId。
- source_record_identity jsonb：完整稳定来源ID，仅来源说明，不复制Task状态。
- geometry_kind：POINT/LINESTRING/POLYGON及对应MULTI类型。
- native_geometry jsonb object；native_crs text（未知时明确未指定）。
- geometry_wgs84 geometry(Geometry,4326) NULL。
- normalization_state：NATIVE_ONLY / NORMALIZED / INVALID。
- transform_info jsonb；supersedes_target_id；created_at。

规范：
1. 标准化图形必须类型正确、非空、有效且坐标范围正确。
2. NORMALIZED时才有geometry_wgs84；本轮不做新的CRS推断服务。
3. ST_SetSRID只声明坐标含义，不进行转换；不把未知x/y标为WGS84。
4. 图形不是设备当前位置：不写world_object_geometry当作真实到达位置。
5. 同一目标修订不可覆盖geometry/CRS/来源；变化创建新修订。
6. supersedes必须同group、同scope，修订顺序一致。
7. 同区域可被两设备任务引用，geometry本身不强制属于一台设备；使用关系必须符合scope。

## gowm_task.target_binding

- target_binding_id uuid PK；target_id FK。
- device_id（设备使用必填）；data_scope_key。
- owner_domain：SDAR / SMPP / UGV_PROVIDER。
- owner_kind：TASK / PLAN_NODE / NODE_RUN / MCP_TASK / PROVIDER_DISPATCH。
- owner_key jsonb object：完整原生身份；使用JSONB结构不靠namespace:id无界拼接。
- usage_role：REQUESTED / PLANNED / DISPATCHED。
- target_purpose：MOVE_DESTINATION / OBSERVATION_AREA / ROUTE / 其他明确业务语义。
- argument_path：实际JSON输入字段路径；created_at。
- UNIQUE(owner_domain,owner_kind,owner_key,usage_role,argument_path)。
  重复写同一target_id幂等；同一精确owner输入改绑另一个target_id报冲突。计划变化以新的Plan修订/Node Run/派发Step owner_key记录，不能覆盖已派发绑定。

固定Schema允许按白名单owner_kind验证真实表：
TASK → ugv_sdar.agent_task；
MCP_TASK → ugv_smpp.provider_task；
PROVIDER_DISPATCH → ugv_smpp.ugv_mutation_journal及execution；
Plan/Node Run按当前原生结构映射。

不要在CHECK里执行跨表查询。写入函数/Repository在同事务中验证owner存在、device与scope一致。
不是每个多态owner都能用一个普通FK完成；函数必须实际实现并测试，不能只留TODO。
临时未安装某个business domain时，不开放该domain写入；单独公共建表允许完成，不伪造owner。

## 保留完整目标链

Task要求 → Plan采用 → Node Run实际输入 → MCP arguments → Provider dispatch arguments。
可确认同一目标时复用同一target_id；转换后目标不同则保存新修订或明确派发目标。
保留原生arguments JSON，不自动扫描历史JSON回填、不根据相近坐标猜关联。

禁止对已派发目标“原地更新”，造成历史Mission的目标悄然变化。


---

# G06 — Mission身份与执行关系：三张公共表

## gowm_execution.device_mission

mission_instance_id uuid PK；
device_id / data_scope_key；
mission_channel text（例如CHASSIS或OBSERVATION；实际值通过适配合同明确）；
world_object_id text NULL（已存在GOWM Mission对象时引用）；
created_by、created_at。

同一Mission世界对象不重复登记；验证与设备scope一致。
不建立第二份运行状态机，不复制provider state当作GOWM真值。
Mission尚未创建或信息不足时，不为补齐图而虚构实例。

## gowm_execution.mission_identity

identity_id uuid PK；
mission_instance_id；
device_id、mission_channel；
authority_key、identity_kind、native_session_key、native_mission_id；
evidence_ref jsonb；
created_at。

唯一键：
(device_id,mission_channel,authority_key,native_session_key,native_mission_id)。

identity_kind可为MISSION_ID_WITH_SESSION / RUN_KEY / EXECUTION_SCOPED_ID。
native_session_key必须有真实来源；只有Provider execution范围可用时明确EXECUTION_SCOPED_ID，不假装设备全局session。
不同设备相同mission_id允许共存；同设备不同原生会话复用mission_id允许共存。
Provider局部epoch和MQTT ingest局部epoch没有自动等价关系。
同一Mission可以有多个明确验证的别名；没有共同回执/命令身份时保持未解析，不能按时间接近合并。

## gowm_execution.execution_mission_link

字段：
- link_id uuid PK；device_id / data_scope_key；binding_id。
- mcp_task_id：对应共享ugv_smpp当前原生Task主键类型，初始可为空。
- provider_execution_id：真实外部Execution身份。
- provider_task_record_id：ugv_execution真实主键，不能默认等于MCP ID。
- provider_dispatch_step_id：Provider派发日志步骤，不是SDAR Node。
- mission_instance_id NULL。
- relation_kind：CREATED / CONTROLLED / OBSERVED。
- link_state：PENDING / LINKED / UNCERTAIN / CONFLICTED。
- source_system_key、idempotency_key、source_evidence_ref jsonb。
- unresolved_native_identity jsonb NULL；created_at / updated_at。

**不含smpp_store_id/provider_store_id/sdar_store_id**。
明确mcpTask身份若已存在，应校验同设备。异步接纳尚未形成MCP task时允许为空，并在已有业务回执事务补齐，不建立强制错误写入顺序。
派发记录存在性和同设备由固定Schema FK/写入验证保证；不得用跨服务FK强迫尚未发布的父记录先提交。

关系原则：
- LINKED必须有mission_instance_id与明确证据。
- PENDING没有已确认Mission是正常情况。
- UNCERTAIN/CONFLICTED不强制删除已有证据引用，但不得在公共查询中显示为“已确认关联”。
- 一Task可零到多Mission；一Mission可被多个控制派发引用。
- 一派发确实返回多个Mission时保留多条明确关联，幂等键包括稳定来源事件/分项身份。
- 重复同一个回执不新增重复关联；不同载荷却相同幂等身份返回冲突。
- 下游MISSION数字数组只能作为汇总，不替代逐派发证据。

## 读取关系

SDAR remote_task_binding
→ 真实MCP Task身份及稳定smpp_service_key
→ ugv_smpp.provider_task
→ ugv_execution
→ ugv_mutation_journal
→ execution_mission_link
→ device_mission / mission_identity。

在G00核对Repository实际赋值后确定JOIN，禁止只因列都叫task_id就判定相等。
接口返回缺失阶段：
NO_REMOTE_TASK / PROVIDER_PENDING / MISSION_UNRESOLVED / LINKED / CONFLICTED。
不要把缺少关联解释为“从未执行”，也不要把LINKED解释为“任务物理完成”。

与GOWM已有Mission world_object关联时只引用同一对象；不新建重复world object。
设备遥测仍正常进入既有观测链；此任务只提供身份写入和查询，不启动MQTT同步，不产生合成Operational Event。


---

# G07 — 实际可调用的存储合同与公共读取

## 交付原则

不能只交付DDL。GOWM仓库中实现一个小型共享业务存储包，放到现有workspace可包含的位置，例如：
`packages/integrations/device-business-storage/`。

它包含：
- typed配置/请求/结果模型
- pg事务内的设备/目标/Mission写入函数或Repository
- 固定Schema读取Query
- 安装、校验、Fixture CLI
- 测试使用的同一实现

这不是新的执行编排器。SMPP/SDAR后续可以用其合同/SQL适配现有Repository；不得要求两仓必须引入新的复杂运行时平台。

## 写入事务合同

下列建议入口可以采用TS Repository，或少量SQL函数+TS包装。选择一套实际实现，不同时维护两份同义逻辑：

registerDevice
registerDeviceStream
replaceDeviceServiceBinding
attachTargetToOwner
registerMissionIdentity
linkExecutionToMission

每项明确：
- 参数及设备Scope
- 原生记录身份
- 幂等或重复处理
- 同设备/同Scope校验
- 必要的事务边界
- 返回的持久化ID及错误码

只读世界对象/观测不能被这些函数改写为设备执行事实。登记已有设备可更新设备管理属性，不替换原observed state。

原生Task/Invocation/Execution的完整创建继续由原应用负责。
本包提供供后续适配的设备范围查询/写入样例与验证，不重新实现SMPP状态机。
若必须新增一个helper SQL支持共享幂等或claim，应复用原有状态字段并标明它是存储原语，不是第二份Task表。

## 固定只读Schema

`gowm_business_v1` 至少提供以下视图，逐项验证真实字段映射：
- device_catalog
- device_ingest_routes
- device_service_bindings
- sdar_tasks
- workflow_steps
- mcp_tasks
- provider_executions
- provider_dispatches
- mission_links
- task_target_geometries
- task_execution_lineage

视图只读，不使用可写VIEW代替旧Repository兼容层。
所有设备行输出device_id；业务身份输出必要source namespace，不能回到storeId/动态Schema。
source table和上游字段映射放在 `read-model-mapping.json`。

## 查询函数/Repository

提供少量明确输入的查询方法：
```
listDeviceTasks(deviceId, timeRange?, limit, cursor?)
getTaskLineage(deviceId, sdarTaskId)
getMissionLineage(deviceId, missionInstanceId)
getTaskTargets(deviceId, taskId)
getMcpTaskDetails(deviceId, mcpTaskId)
getLatestDeviceSnapshot(deviceId, sourceKey?, channel?)
```

- deviceId必填；全设备管理汇总用另一个明确命名的调用，不以NULL表示所有设备。
- ID查到别的设备记录时不得返回；FK与读取校验均需测试。
- 相同设备不足以关联Task，必须使用明确的Task/Node Run/MCP/派发ID。
- 排序稳定，基本分页有界；不用复杂游标认证框架。
- left join保留未启动节点、未完成回执、未解析Mission，不能inner join丢掉未执行计划。
- 并行/循环/子Workflow的不同Node Run分开；同nodeId两次尝试不能合并。
- JOIN扇出需按真实实体列表分组，不通过DISTINCT任意抹掉不同执行。
- 结果分开包含sdar状态、mcp状态、provider状态、mission关联状态；不生成统一“成功”字段。
- GOWM observation中subject是被观察目标时，禁止以subject_id=device_id硬拼全部传感器观测。

## 目标Owner验证

owner_domain和owner_kind映射到固定表白名单；owner_key包含实际完整键。
不得把owner_key直接当table name或SQL片段。
PLAN_NODE读取对应Plan中真实definition JSON验证node存在；NODE_RUN读取真实执行记录和attempt，不编造Node Run。
实际源结构若不提供统一nodeRun表，可以按现有事件/绑定记录建立只读投影，写入验证仍要有真实出处。

## Scope与权限

沿用GOWM已有data_scope与角色模式；基本写入函数只允许自己的数据域。
不创建逐设备数据库用户，不要求新JWT/RLS/Policy系统。
跨设备FK和Scope校验属于数据正确性；凭据只通过现有env/secret引用供部署者设置。
shared roles不能修改GOWM原有核心表状态；公共读取不暴露token、密码、原始认证headers。


---

# G08 — 安装、配置、仓库交付与后续接线

## 建议仓库产出

```
docs/device-business-storage-v0.2/
  architecture.md
  data-dictionary.md
  source-inventory.json
  native-transform-map.json
  device-scope-key-inventory.json
  repository-adaptation-matrix.md
  read-model-mapping.json
  transaction-and-retention-contract.md
  smpp-handoff.md
  sdar-handoff.md
  mqtt-ingest-handoff.md

contracts/device-business-storage-v0.2/
  storage-contract.json
  request-result schemas或TS类型说明
  examples/
  manifest.json

database/migrations/
  <next>_device_shared_business_foundation.sql
  后续必要公共迁移

database/shared-business-storage/
  源迁移、托管转换、固定Schema安装产物及overlay

packages/integrations/device-business-storage/
  src/
  tests/

scripts/device-business-storage/
  cli.ts

reports/device-shared-business-storage-v0.2/
  FINAL_REPORT.md
  FINAL_REPORT.json
```

路径按现有workspace调整，不能为了该功能改造成另一个构建系统。
不把原生业务库的几十份迁移混入GOWM core数字序列；新增core公共表不修改原有迁移校验值。
发现现有检查需要识别新增文件，只做精确的增量扩展，不禁用原有guard、不整体重写历史freeze lock。

## 建议新增命令（命令必须真实实现）

```
npm run business-storage:check
npm run business-storage:install -- --domain all --help
npm run business-storage:install -- --domain smpp
npm run business-storage:install -- --domain sdar
npm run business-storage:verify
npm run business-storage:test:postgres
npm run business-storage:fixture -- --help
npm run business-storage:handoff
```

命令语义：
- check：静态校验来源、安装清单、9表合同、生成物一致性，不连接数据库。
- install：在指定数据库安装当前GOWM所需公共表和选定固定共享domain；核心未满足前置时报具体依赖，不静默创建假的world_object。
- verify：检查实际DB中的表/列/FK/索引/函数/迁移family及固定Schema，输出结构结果，不假装应用已接线。
- test:postgres：在隔离数据库执行真实事务、双设备与读写测试。
- fixture：仅显式测试数据库允许写模拟行，重复执行幂等；正常命令不自动污染运行数据库。
- handoff：打包当前DDL、列/键变更、连接配置、SQL样例、来源清单和测试摘要，不执行消费端改造。

命令help必须无需DB就成功。实际验证缺环境返回NOT_RUN，不以退出0+PASS冒充已测；总报告正确汇总。

## 配置

复用现有实际database name，不新建硬编码业务database：
```
GOWM_DATABASE_URL=<existing database>       正常安装由部署者明确指定
GOWM_BUSINESS_TEST_DATABASE_URL=<isolated test database>
GOWM_BUSINESS_SMOKE_ENABLE=false
```

不提供真实凭据，不自动连接用户正在运行的实例。
连接模板可说明SMPP/Provider使用同一个数据库+ugv_smpp，SDAR使用同一数据库+ugv_sdar。
禁止全库默认deviceId。后续消费者每次业务请求传deviceId，Worker传明确allowedDeviceIds。

## 安装与既有数据

本轮是新存储准备，不执行历史回填、在线切换、清空旧数据。
安装器遇到未知但非空的业务Schema，不执行DROP/重建；输出已检测结构和最小处理提示。
若已存在本设计的已登记版本，使用幂等前向迁移。
测试不因避免误删而引入复杂多级审批，只需显式隔离DB、标记和已知测试行前缀。
禁止在测试失败时全库DROP SCHEMA CASCADE清理运行库。
core角色/扩展在同集群其他库可见，测试创建角色须避免影响既有角色，或复用既有测试配置。

## 三份独立消费者交接

### SMPP
明确：
- 连接固定ugv_smpp
- 根记录device_id/binding_id写入
- scoped idempotency/snapshot/cursor/claim SQL的替换点
- 对真实resource/adapter路由的设备绑定
- 迁移verify-only
- Task句柄过期与长期历史保留
- Provider Mission Link与派发回执同事务写入

### SDAR
明确：
- 连接固定ugv_sdar
- Task设备归属、Plan/Node Run实际关联
- native/public SQL适配、源键命名空间
- Remote Task关联逻辑smpp_service_key
- 目标图形及实际使用修订落库
- 任务领取/恢复的device范围
- 不直接插入SMPP任务来代替MCP调用

### MQTT Ingest
明确：
- 从设备配置读连接/路由
- message→唯一deviceId
- 原生Mission身份保留来源session
- observer/device与subject不同
- 不更改旧会话上下文解释历史消息

**不产出声称已应用的跨仓补丁，不修改三个消费者仓库。**
后续接线风险必须按明确代码位置列出，不能仅写“改连接串即可”。


---

# G09 — 双设备、同一套表的验收

## 两级验证，但只有真实存储通过才能叫storage ready

A. 无外部依赖：
静态合同、DDL生成、类型、纯函数、schema检查、原有GOWM回归、所有CLI help。

B. 真实PostgreSQL：
安装两业务domain，实际使用新增Repository/函数写入读取、事务、双设备隔离、并发claim和历史查询。
数据库可以是本机进程、现有专用测试实例；不要求Docker，不强制启动SACS/WSGS/SDAR/SMPP应用。
可选使用只读checkout的源Repository读取路径做额外兼容验证，不修改源仓库。
Mock pg/AST通过不能代替真实数据库B。

若无测试DB：
继续完成代码和A，不等待、不索要确认；B标记NOT_RUN，最终只能SOURCE_READY，不能STORAGE_DEV_READY。

## Fixture定义

创建两个明确标记的TEST scope设备A/B，复用同一`ugv_smpp`/`ugv_sdar`表。
每台：
- 一个SDAR Task，包含Point目的地和Polygon观察区域；
- 一份Plan，两个业务Node，至少一个重试Node Run；
- 对应MCP Task、Provider Execution与两个可区分的Dispatch；
- 一条已关联Mission，一条尚未关联/UNCERTAIN执行；
- 同一原生Mission编号在两车出现；
- 相同快照revision、幂等键文本、source本地sequence；
- 设备A更换逻辑服务绑定，旧Task仍保留旧device/binding。

全部是存储Fixture；不得调用设备、网络导航或生成真实执行证据。
示例坐标、MQTT地址仅测试使用，不能当作用户真实园区配置。
如果原生多阶段创建事务复杂，Fixture必须走实际本包Repository/存储接口，不绕过约束硬插半条数据。

## Required场景索引

T01 既有world_object设备登记，不产生平行设备ID。
T02 跨scope device/datastream绑定被拒绝。
T03 同broker不同设备topic/payload正确解析；unknown不归ugv1。
T04 wildcard重叠路由能报告AMBIGUOUS。
T05 同service/resource错误绑定两设备被拒绝。
T06 一个MCP逻辑server可服务两设备，不被错误unique约束。
T07 替换绑定后旧Task/目标/执行归属不漂移。
T08 两个domain从空结构安装；应用对象不污染public。
T09 重复安装不新增Schema/迁移记录；第三台设备不触发DDL。
T10 SMPP Runtime/UGV两个family完整，合法重复014不丢失。
T11 SDAR baseline+增量正确；函数/序列/FK/vector引用可执行。
T12 两设备同业务表写入，根记录归属明确。
T13 A设备子记录不能指向B设备Task/Execution。
T14 两设备同idempotency key文本独立，同设备重发返回同记录。
T15 同一幂等身份不同参数冲突且不额外派发记录。
T16 两设备同snapshot revision可共存；最新读取只返回指定设备。
T17 两设备cursor/stream sequence独立推进。
T18 Worker A仅领取A设备任务；不处理B任务。
T19 两Worker竞争同一设备同一Task只能一个领取；重启owner变但业务ID不变。
T20 Lease同一资源互斥，不同设备同类型资源互不误锁。
T21 原生Task创建+设备/目标使用关系事务失败后全部回滚。
T22 Point/Line/Polygon合法标准化；未知frame保留NATIVE_ONLY。
T23 修改目标产生新修订；旧Plan/Dispatch仍指向旧目标。
T24 不存在owner、错device、错scope的target binding写入失败。
T25 一Task多个Node Run/MCP Task链路保留，不因重复nodeId合并。
T26 两设备相同native mission_id不同实例；同设备不同session复用也不同。
T27 重复Mission回执幂等；来源冲突不按时间猜合并。
T28 PENDING/UNCERTAIN保留无Mission；cancel/control不自动新建Mission。
T29 Task→目标→Plan/NodeRun→MCP→Execution→Dispatch→Mission正向回读。
T30 Mission→Task反向回读，并返回缺失/冲突阶段。
T31 Task句柄过期后历史链仍可查；不启动旧purge行为。
T32 相同数据库前缀未限定名不会误落public；安装与应用search_path分别验证。
T33 原有GOWM设备/历史/观测/契约检查不被新增模块破坏。
T34 禁止生成实例Schema/storeId/虚假ReferenceKey的静态回归。
T35 缺少vector或DB时输出真实NOT_RUN/依赖失败，不伪造SDAR已安装。
T36 源台账、九表字典、变换清单、固定域读写合同及三份消费者交接齐全。

测试数不必机械等于36；一个场景可多测试，多个场景可共享fixture，但报告逐项说明实际覆盖。
失败测试不允许删掉、标skip换取通过。环境项可NOT_RUN，行为失败是FAIL。


---

# G10 — 阶段、验收与结束条件

## 顺序

P0 基线与源盘点：
记录当前HEAD/安装入口/原生表依赖/共享范围风险。
输出真实table inventory和key inventory。

P1 合同收口：
在GOWM提交当前共享数据布局、9张公共表、固定Schema、ID范围、安装与读写契约。
这是代码内的短暂收口阶段，不等待用户另行签字；后续实现遵守同一合同。

P2 公共设备表与配置访问：
实现4张设备公共表、Scope检查、服务绑定替换、MQTT路由解析纯函数。

P3 共享原生业务安装：
实际生成并安装ugv_smpp、ugv_sdar，隔离原生迁移family和GOWM核心迁移，处理public对象/函数/扩展。
必须是完整执行依赖，不是空Schema或几张缩略表。

P4 共享设备overlay：
实际落库device scope列、FK/unique、Idempotency、Snapshot、Cursor/Claim所需键与Query接口。
不修改SMPP/SDAR源运行代码。

P5 目标与Mission：
实现2张目标表、3张Mission关联表及真实写入验证；保留异步未关联、重复回执和冲突语义。

P6 统一查询和双设备验证：
固定只读查询、完整链正反查、同库双设备、事务、并发、scope回归。

P7 交接和交付：
更新文档、命令、`.env.example`（只示例）、来源清单、实际结果报告；提交GOWM功能分支。
用户授予仓库写入环境时push并创建GOWM Draft PR；不merge、tag、release。
推送/PR失败只标记交付状态，不把已验证存储功能判为失败，也不能伪造PR链接。

## Required Commands

现有基线：
```
npm run check
npm run build
npm test
npm run verify:sql
```

新增：
```
npm run business-storage:check
npm run business-storage:install -- --help
npm run business-storage:fixture -- --help
npm run business-storage:handoff
npm run business-storage:test:postgres
```

其中最后一项需要真实隔离PostgreSQL。可对同一测试DB执行install/verify验证完整流程。
如果测试环境没有数据库/必要扩展，其他工作继续，记录明确NOT_RUN，不能以Mock替代storage-ready。
不要求Docker、设备、WSGS、SACS真实联调；不要求HA/压测/灾备。

## 完成标志

所有必需实现、静态/回归与真实数据库测试都通过：
```
GOWM_DEVICE_SHARED_BUSINESS_STORAGE_DEV_READY
```

代码与无外部依赖检查完成，但真实PostgreSQL未运行：
```
GOWM_DEVICE_SHARED_BUSINESS_STORAGE_SOURCE_READY
POSTGRES_VALIDATION_NOT_RUN
```

有必须功能、迁移、静态或数据库行为测试失败/未实现：
```
GOWM_DEVICE_SHARED_BUSINESS_STORAGE_INCOMPLETE
```

这三个状态互斥。不把SOURCE_READY写成部分DEV_READY。
SMPP/SDAR应用是否完成后续接线，始终另列：
```
SMPP_RUNTIME_ADAPTATION_NOT_PERFORMED
SDAR_RUNTIME_ADAPTATION_NOT_PERFORMED
LIVE_MQTT_SWITCHOVER_NOT_PERFORMED
```

## Required验收的核心

- 仅改GOWM；最新用户共享库方案优先。
- 固定两个共享业务Schema，9张公共业务表；没有业务storeId和实例Schema。
- 完整原生业务依赖可安装，重复安装无重复DDL，既有GOWM不受破坏。
- device_id有明确来源，不存在全库ugv1默认或按进程推断历史设备。
- Scope、设备父子关系、稳定主键、来源命名空间正确。
- Snapshot/Idempotency/Cursor/Claim适合双设备共享，不只新增列。
- 目标精确修订与原始坐标保留，实际派发目标不漂移。
- Mission在明确设备+来源范围内关联，未知/冲突不假合并。
- 真正的Task–Step Run–MCP–Execution–Dispatch–Mission正反查通过。
- 正式交付DDL与可测试数据接口，不只提交设计文档。
- 交接说明准确区分storage ready和消费者runtime ready。


---

# G11 — 最终报告与消费者交接

## 报告文件

`reports/device-shared-business-storage-v0.2/FINAL_REPORT.md` 和同名JSON。

必须包含：
1. Scope：实际只修改的仓库，未触及的消费者。
2. 实际base/head、源SMPP/SDAR commit与安装入口。
3. 旧设计替换情况：business_store、实例Schema、store FK的处置。
4. 实际新增9张公共表及物理名；如等价复用，说明对应。
5. ugv_smpp/ugv_sdar安装对象数、依赖、迁移family、转换清单。
6. `device-scope-key-inventory.json`的逐项结果，尤其claim/idempotency/snapshot/lease。
7. 图形与Mission验证的实际结果。
8. 所有执行命令及退出码/测试数，未运行原因。
9. 是否真实访问隔离PostgreSQL、扩展版本、测试数据库脱敏标识。
10. 双设备正反向查询的输出摘要；Fixture说明。
11. 不兼容旧Repository的字段/索引变更及消费者后续位置。
12. 真实应用接线、旧数据迁移、MQTT切换均NOT_PERFORMED。
13. 实际branch/commit及Draft PR状态；不能制造链接。
14. 最终标志与剩余事项。

报告不得写入连接串密码、完整认证头或真实敏感配置。
不要求exact-head发布资格链、重复签名清单或Native Analysis Handoff。

## 建议JSON

{
  "taskId": "gowm-device-shared-business-storage-v0.2",
  "decision": "DEV_READY | SOURCE_READY | INCOMPLETE",
  "implementation": {
    "targetRepositoryOnly": true,
    "fixedSchemas": ["ugv_smpp", "ugv_sdar"],
    "instanceScopedBusinessStores": false,
    "deviceRootOwnershipImplemented": true,
    "sourceRepositoryAppsModified": false
  },
  "sources": {},
  "publicTables": [],
  "nativeDomains": {
    "ugv_smpp": {"install": "PASS | FAIL | NOT_RUN"},
    "ugv_sdar": {"install": "PASS | FAIL | NOT_RUN"}
  },
  "verification": {
    "static": "PASS | FAIL",
    "postgres": "PASS | FAIL | NOT_RUN",
    "dualDevice": "PASS | FAIL | NOT_RUN",
    "forwardReverseLineage": "PASS | FAIL | NOT_RUN"
  },
  "consumerReadiness": {
    "smppRuntime": "NOT_ADAPTED",
    "sdarRuntime": "NOT_ADAPTED",
    "mqttIngest": "NOT_SWITCHED"
  },
  "requiredAcceptance": [],
  "remainingIssues": [],
  "delivery": {"commit": null, "draftPr": null},
  "finalMarker": "..."
}

该JSON是本任务报告模板，不是任何OpenAI/Codex产品官方格式。

## 消费者交接包最少内容

```
shared-business-storage-handoff/
  storage-contract.json
  data-dictionary.md
  device-scope-key-inventory.json
  namespace-transform-map.json
  read-model-mapping.json
  repository-adaptation-matrix.md
  connection-examples.env
  dual-device-fixture-description.md
  smpp-handoff.md
  sdar-handoff.md
  mqtt-ingest-handoff.md
  verification-summary.json
```

SMPP/SDAR开发可在冻结的同一合同上分别开展，不需要边写边改GOWM字段。
若后续运行发现合同确有问题，应独立提交小型修订，不让实现者绕过device范围或新增实例Schema。

## 最终答复格式

说明：
- 完成了哪些共享表和读取功能。
- 真正验证过哪些内容。
- 哪些内容未运行。
- 后续消费端必须改哪些最小接点。
- 分支、提交、Draft PR真实状态。
- 一个正确的最终标志。

不能以“已入GOWM数据库”描述只生成SQL的情况。
不能以“全链路贯通”描述只完成GOWM存储Fixture的情况。


---

# 来源、已核查事实与未验证边界

生成日期：2026-09-08。当前文件是任务包来源说明，不是代码审计或数据库通过报告。

## 用户明确决策

- GOWM是设备主档与共享业务存储管理方。
- 所有UGV共享ugv_smpp/ugv_sdar，通过device_id区分。
- 不为每个运行实例/设备安装一套业务库。
- 任务与目标图形、Workflow/Step Run、MCP Task、Provider执行和Mission都需要保留。
- 只改GOWM，其他仓库按冻结合同随后分别适配。
- 不要重复导出采集业务记录，不要产品级治理阻碍开发。

## 本轮实际读取

|编号|来源|读取范围/结论|
|---|---|---|
|R1|GOWM refs/heads/main|dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838|
|R2|SMPP refs/heads/main|b974471dd62665721a5edcc63b7651d2f476160d|
|R3|SDAR refs/heads/main|cb50da8ec8d160a673852be8bcdfc3bb094f5ce5|
|R4|GOWM package.json|0.7.1；check/build/test/verify:sql与db:migrate等脚本存在|
|R5|GOWM scripts/migrate.ts|core数字序列、换行Hash、schema_migration及角色设置；不能混入外部不连续迁移|
|R6|SMPP migrations/runtime/002_task_lifecycle.sql|Task、Admission、Idempotency、Observation、Outbox、Lease等完整依赖；幂等基础键不含device维度|
|R7|SMPP migrations/providers/ugv/024_ugv_provider.sql|UGV Execution、ACK、Snapshot、事件流；snapshot以revision作主键|
|R8|SDAR infra/postgres/baseline/0001_sdar_v1_2_2_baseline.sql，前105行|显式public对象、函数与search_path语句、vector；不是可直接重放到GOWM public的脚本|
|R9|对话附件Design_CN.md全文|旧设计按store托管且跨表引用store_id，现已被用户最新决定取代|
|R10|对话附件design.sql全文|旧10张公共表SQL仅设计草案；本包不随附、不执行它|

所有当前分支后续可能更新。实施时重新读取真实安装入口与完整依赖；不能仅根据本表的代表性文件宣称已审完全部表、全部运行实例或运行数据。

代码位置（固定读取来源）：
```
https://github.com/zhouwen-giser/geospatial-operational-world-model/blob/dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838/package.json
https://github.com/zhouwen-giser/geospatial-operational-world-model/blob/dd1b038fa0fa3e3893d7f4c7f815bfe9992b0838/scripts/migrate.ts
https://github.com/zhouwen-giser/sdar-mcp-provider-platform/blob/b974471dd62665721a5edcc63b7651d2f476160d/migrations/runtime/002_task_lifecycle.sql
https://github.com/zhouwen-giser/sdar-mcp-provider-platform/blob/b974471dd62665721a5edcc63b7651d2f476160d/migrations/providers/ugv/024_ugv_provider.sql
https://github.com/zhouwen-giser/skill-driven-agent-runtime/blob/cb50da8ec8d160a673852be8bcdfc3bb094f5ce5/infra/postgres/baseline/0001_sdar_v1_2_2_baseline.sql
```

## 数据库语义参考

PostgreSQL Schemas：
```
https://www.postgresql.org/docs/current/ddl-schemas.html
```
一个连接直接访问一个database中的多个schema；未限定对象名由search_path解析。应用Schema与public扩展必须分别处理。

PostgreSQL Constraints：
```
https://www.postgresql.org/docs/current/ddl-constraints.html
```
复合键/外键用于约束同设备父子关系。跨表多态owner检查不能只写成一个普通CHECK。

PostgreSQL SELECT：
```
https://www.postgresql.org/docs/current/sql-select.html
```
SKIP LOCKED用于队列类并发，不提供设备路由/归属判定。

PostGIS：
```
https://postgis.net/docs/ST_SetSRID.html
```
ST_SetSRID只改SRID元数据，不转换坐标。目标坐标转换要有明确CRS依据。

以上只用于实现语义参考，不要求升级到文档“current”的PostgreSQL版本。以项目实际支持环境为准。

## 本轮未做

未修改仓库；未执行GOWM/SMPP/SDAR测试；未安装DDL；未连接用户数据库；未生成真实设备Mission。
任务包文件完整性通过，不代表上述项目验证已经通过。

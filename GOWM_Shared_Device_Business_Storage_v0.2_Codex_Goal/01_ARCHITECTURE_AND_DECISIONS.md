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

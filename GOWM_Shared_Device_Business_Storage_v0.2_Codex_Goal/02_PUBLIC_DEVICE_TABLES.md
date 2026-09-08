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

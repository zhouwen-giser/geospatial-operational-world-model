# MQTT Ingest 单仓接入

状态：LIVE_MQTT_SWITCHOVER_NOT_PERFORMED。

从 device/mqtt_endpoint/device_stream 读配置，不存明文凭据，只用 credential_ref。broker 可共享；每进程完整 client ID 必须唯一，client_id_prefix 不是完整 client ID。

使用 resolveIngestDevice(endpoint,topic,payload)。BOUND_DEVICE 不能跨设备重叠；TOPIC 用零基 segment，PAYLOAD 用显式 path 数组，equals 为设备外部标识。不执行脚本。无匹配返回 NO_MATCH，多设备匹配返回 AMBIGUOUS，均不得默认 ugv1；同一设备多路命中可去重。

接线位置：packages/integrations/ugv-mqtt-ingest-core/src/mapper.ts 及现有 ingest 配置/Repository。订阅上下文必须冻结旧 session 的 mapper/身份解释，设备改名/服务替换不重算历史归属。观测 subject 可能是目标，observer 才是本车；继续复用 source_registry、producer_pipeline、datastream 和 ugv_ingest 现有链。

原生 Mission 关联保留 device+channel+authority+真实 native session+mission ID。无共同回执时不合并 Provider epoch 与 MQTT session。仅登记/解析配置，不在本任务连接 broker、发布消息或改运行采集服务。

## GOWM mapper v3 接线更新

GOWM 侧已接通主档解析、冻结会话上下文和事件 actor；原文“仅登记/解析配置”描述的是 v0.2 初始交付范围。
运行切换仍需部署执行。初始化、权限、双设备和兼容步骤见 [设备 actor 部署说明](../UGV_DEVICE_ACTOR.md)。

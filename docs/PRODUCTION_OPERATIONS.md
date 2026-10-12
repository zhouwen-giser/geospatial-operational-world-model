# 可选受控入口与运维

本仓提供可执行的 HTTPS/mTLS、MQTT TLS/ACL、范围诊断和逻辑备份/隔离恢复。它们已在本任务隔离环境验证；不自动应用到 sz-gowm，也不代表 HA、WAL/PITR、RPO/RTO 或生产容量已验收。

## 可选 production overlay

使用 `docker-compose.yml + docker-compose.world-platform.yml + docker-compose.production.yml`，不包含 dev 或 sample overlay。现有 dev-deploy 继续使用受信 LAN/VPN 模式，不会自动改变已部署端口、网络或依赖。

production overlay 清除旧 REST/MCP/DB/Provider/采集器的 host port，只发布 HTTPS Gateway 8443 和认证 TLS MQTT 8883，默认绑定 127.0.0.1。要发布到指定可信网卡须显式配置 TLS_BIND_ADDRESS 和防火墙。内部服务使用 internal default network；TLS edge 和 MQTT 加入 world-edge。采集器另接独立 ugv-source-egress 出站网络，保持访问已批准的外部设备 broker，不发布采集端口；主机防火墙需限制其 broker 目标。原数据卷名称不改变。不得将 development edge 网络中的任意容器视为已授权身份。

HTTPS edge 使用现有应用镜像和 Node HTTPS，最低 TLS 1.2。证书/key 为普通只读文件；设置 TLS_CLIENT_CA_CONTAINER_FILE 后必须提供合法客户端证书。mTLS 是附加传输条件，Gateway 原有 STATIC_SERVICE/SIGNED_DELEGATION 授权仍须满足。edge 固定转发到该 Gateway，不接受客户端提供 upstream；移除客户端 Forwarded/X-Forwarded 和 hop-by-hop header，限制请求体 8 MiB、header 16 KiB、同时请求 128，流式返回结果。健康端口只证明 edge 进程可接收连接，不证明业务或数据库就绪。

GOWM_OPS_SECRET_DIR 必须是现有绝对目录，至少有：

| 文件 | 内容与使用者 |
| --- | --- |
| server-cert.pem / server-key.pem | 真实服务器证书/对应私钥，Gateway edge 与 broker |
| ca.pem | 证书链/CA；可作为 edge 的客户端 CA，按部署 PKI 决定 |
| mqtt-passwords | mosquitto_passwd 生成的哈希文件，含 gowm_bus、ugv_ingest、ugv_source |
| bus-password | gowm_bus 的原密码，供内部 WorldEventBus 读取 |
| ugv/ | 独立采集器 secret 目录；不向采集器挂载 broker 私钥或其他账号密码 |

使用已存在的证书和密码管理流程。通过 `mosquitto_passwd` 的交互式提示逐个设置账号，不把密码写入命令行、报告或包；bus-password 应与 gowm_bus 对应。文件/目录只向容器实际 UID/GID 开放必需读取权限（应用默认 node，broker UID 以实际镜像检查结果为准），不能靠所有人可读私钥解决权限。TLS edge 和 bus 各只挂载所需文件。

broker 的版本化配置/ACL 在 infrastructure/production：内部 1883 不发布但同样要求账号；8883 使用 TLS。gowm_bus 只读写 gowm/#；ugv_ingest 只读七条业务主题和 /sim/reset_ack；ugv_source 只发布这八个主题。reset_cmd 不在本轮 ACL 中，其他设备/指令需单独审阅授权，不使用宽泛的全主题通配符。

采集已有 UGV_MQTT_USERNAME、PASSWORD/CA/CERT/KEY 文件配置；生产挂载路径在 /run/ugv-secrets。保留真实既有 broker 地址，不自动切到本地 broker。采用该 broker 时配置 mqtts 地址、对应 ugv_ingest 凭据和 CA。内部 WorldEventBus 增加 MQTT_USERNAME/PASSWORD_FILE/CA_FILE/CERT_FILE/KEY_FILE，TLS 验证始终开启，不在 URL 嵌密码。无凭据仍仅用于明确的开发匿名 broker，不会在认证失败时降级匿名。

只读预检（源码使用 npm 命令，已构建镜像使用 dist 入口）：

```bash
npm run production:check
# 或 node dist/scripts/production-check.js

docker compose --env-file <approved-private-env> \
  -f docker-compose.yml -f docker-compose.world-platform.yml \
  -f docker-compose.production.yml --profile foundation-admin \
  --profile world-platform --profile ugv-mqtt config --quiet
```

预检验证文件、证书/key 配对、有效日期及三个哈希账号存在；不证明密码已在 broker 认证。Compose config 不应将包含凭据的完整渲染结果写入普通日志。

这是独立 opt-in 拓扑。全新部署先按正常初始化流程建立正式库和账号，再启动审阅后的 profile。保留数据升级先执行窄迁移流程、备份并确认消费者依赖，另行授权后仅重建受影响服务；不得对共享现场直接执行整个项目 up/down、账号初始化或 down -v。

## 范围诊断与告警输入

```bash
GOWM_DATABASE_URL=<private-admin-connection> node dist/scripts/operations.js diagnose <data-scope>
# 历史片段/封存/重置的更详细诊断：node dist/scripts/history-diagnose.js <data-scope>
```

诊断建立只读事务并显式设置范围，输出当前设备/观测/态势/Artifact 数、历史队列状态/尝试/等待/有效租约、事件交付索引积压。数据库容量与连接数明确标为整个当前数据库的指标；不含其他数据库名称、完整 SQL、消息、密码或连接串。通过 GOWM_OPS_STORAGE_WARN_BYTES 显式配置存储阈值，未配置不猜容量。

输出 alerts 可交给现有监控：事件索引积压超过 1000 或最旧超过 30 秒、可重试历史队列等待超过 30 秒、过期 RUNNING 租约、idle-in-transaction、连接占 max_connections 80%、存储越过配置阈值。耗尽请求不会因此恢复或重置。续租失败继续使用工作器的结构化脱敏日志；查库无法读取进程内部连接池排队状态，诊断明确标为 NOT_OBSERVED。不能把索引积压为零解释为每个 SSE 客户端已完成消费。

## 一致逻辑备份和隔离恢复

工具需要与服务器兼容的 pg_dump/pg_restore（当前数据库镜像为 PostgreSQL 18）。默认应用镜像不安装 PostgreSQL 客户端；在有匹配工具的受控运维机执行，或显式提供 GOWM_PG_DUMP_EXECUTABLE / GOWM_PG_RESTORE_EXECUTABLE 指向审阅过的匹配工具包装器。本地验证使用本任务数据库镜像中的同版本工具。

```bash
GOWM_DATABASE_URL=<private-source-connection> node dist/scripts/operations.js backup <new-private-directory>
GOWM_DATABASE_URL=<private-isolated-target-connection> node dist/scripts/operations.js verify-restore <backup-directory>
```

backup 只接受新目录，不覆盖旧备份。它保持只读 REPEATABLE READ 事务并导出 snapshot，让 pg_dump 和表检查共享相同快照；数据库继续运行时也不混用不同提交边界。输出 custom-format dump、整文件 SHA-256 和 0600 manifest，保留对象 owner/ACL。备份目录含业务数据，必须按真实数据保护/异地保管规则处理，不能放入部署包。

恢复工具只接受已由管理员单独创建的空 `gowm_restore_check_*` 数据库，拒绝源库、普通名称、非空目标、错误文件摘要和缺失扩展版本/角色；不会创建/删除库或角色，不使用 --clean 或 --no-owner。恢复失败后保留该隔离目标供审计，不自动清理。成功后可人工核对并删除**此次创建的隔离目标**，不能用当前 GOWM 库代替。

工具执行真实 pg_restore，比较所列十类关键表的精确行数及按主键前 100 行摘要，验证扩展版本；本地门禁额外检查 definer owner 与读账号无 INSERT 权限。该内容检查是明确的抽样指纹，不是所有业务表全量语义证明。整文件摘要保护所有备份字节；业务恢复后仍需正式账号和正常协议的验收。

逻辑备份不包括 PostgreSQL 角色密码、外部 secret、主机配置或 broker 持久数据。现有角色/数据库级角色设置须按独立受控凭据恢复流程提供，不能删除安全 owner/ACL 约束使恢复“通过”。工具不向现有库回灌业务数据，不形成业务数据导出同步链。

## 尚需独立落实的生产项

本轮演练结果为 ISOLATED_LOGICAL_RESTORE_VERIFIED。WAL 归档链、时间点恢复、异地完整备份、故障切换/仲裁与 HA、实际 RPO/RTO、长期容量/分区及安全保留策略仍是未完成的生产工作，不能用本次逻辑恢复或模板替代。它们涉及既有数据库、卷和消费者时必须单独授权并在隔离演练后推进。当前不自动清理旧快照/轨迹、Artifact 登记或任何被引用证据。

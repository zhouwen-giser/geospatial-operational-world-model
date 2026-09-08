# sz-gowm GOWM 定向更新记录

部署完成时间：2026-09-08T07:00:15.626059+00:00

- 部署包 SHA256：`33a72b038d7d4e4f8589c4048534391457b1e47a047061253e95bb59f631cbf6`。
- 已验证镜像：`sha256:c33cab88c4b1d5b74a49f9782e5b8e309f29466a2970ecd905d9c4835e712ea2`，直接传输，未重新构建。
- 远端目录：`/mnt/data/gowm-releases/33a72b038d7d4e4f`；入口：`/mnt/data/gowm-current`。
- 原联合部署入口 `/mnt/data/gowm-analysis-current` 保持不变。GOWM 当前使用新目录 `.site/compose.json` 固定镜像，保留联合部署所需网关目录、来源 schema 等原始挂载。

## 更新及保留边界

25 个 GOWM 应用容器已替换，全部健康。旧的 25 个应用容器和 2 个已退出的 GOWM 初始化容器均移除。GOWM 独占本地 MQTT 容器已重建，旧数据卷和匿名日志卷共 2 个已删除。旧应用镜像及其 10 个标签已删除；仍被使用的基础设施镜像保留。

GDPS、GSAP、共享 PostgreSQL、其他项目以及未变更的基础设施，共 16 个受保护容器的 ID、启动时间、环境及挂载均保持不变。原 `.env` 文件字节校验和和各应用容器实际环境变量均一致。共享 PostgreSQL 数据卷同时供 GDPS/GSAP 使用，因此不删除、不重建；GDPS 数据卷及其他项目资源保留，未执行全局 prune。升级前完成在线数据库备份，私密配置和备份仅存于远端 `.site/` 目录。

## 迁移及会话切换

正式迁移器仅新增应用 `079_device_context_reader.sql`，原 78 条迁移已匹配。现场原有 `default` 范围为 TEST，来源默认分析空间为 `default`，而采集器显式使用 `airport-utm48n`；为保留这些原配置，本次使用现有登记 API 的事务化现场脚本复用来源、pipeline 和既有 `ugv:ugv` 世界对象，登记唯一主档和 7 条采集流，没有运行会冲突的模板初始化，也没有改写范围或来源元数据。

停止旧采集器后，2 条残余消息按各自冻结的 v2 上下文处理：1 条按原采样策略忽略，1 条按原失败处理逻辑保留为死信。切换前 inbox/outbox 待处理数均为 0。仅结束 GOWM 自己在外部 MQTT broker 上的持久会话，保持原 client ID，随后建立 epoch 2 / v3 会话；7 个订阅成功。未清理历史事件、旧死信或历史会话。

现场自然产生的一条新版事件已交付并落库，其唯一 actor 为 `wrf_7b166a624f4447929d4bfcdf5fa5779f` 对应的 WORLD_OBJECT，主档为 `ugv:ugv`。证据见 deployment-result.json。

固定共享 SMPP/SDAR 业务域原先未安装，现场 PostgreSQL 未提供 vector 扩展；本次未重建共享数据库或扩展业务域安装范围，也未虚构服务绑定。后续业务消费者接入仍按 GOWM 交接说明进行。

## 运行管理

```sh
ssh sz-gowm /mnt/data/gowm-current/gowm-manage.py status
ssh sz-gowm /mnt/data/gowm-current/gowm-manage.py up
ssh sz-gowm /mnt/data/gowm-current/gowm-manage.py logs ugv-mqtt-ingest
```

该入口只允许管理本次 GOWM 服务，使用 `--no-deps --no-build`，不触及 GDPS/GSAP/PostgreSQL。后续更新联合部署包前须合并此 GOWM 版本，避免旧联合部署配置重新恢复旧应用版本。原联合发布目录仍被保护服务及网关挂载引用，不能删除。

## 部署检查与已知问题

按用户要求未重跑单元测试、集成测试、类型检查或镜像构建。此次仅做包与镜像身份校验、运行就绪检查、配置/容器边界核对，以及读取现场自然消息的会话与落库状态。

既有 `/ugv/area_recon/status` 消息的 `statePatch contains a cycle` 错误在旧 v2 和新 v3 会话均存在，仍会产生死信。本次仅部署已验证包，未改动该问题，不能将容器健康等同于所有侦察状态消息处理成功。

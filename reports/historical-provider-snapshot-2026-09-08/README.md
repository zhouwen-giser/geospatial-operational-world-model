# 历史 Provider 修复与部署交接

- 正式包 SHA256：`9cd8c27088394e333e6ceabd76fc36d3bda9a4f74c39f8de3210734a2b78fad8`
- 运行镜像：`sha256:79b4aa36bd40c02c6d51e1d10a30b41058d6f4e15e6deb1d3d6dd60b0d663857`
- 远端正式包：`/mnt/data/gowm-history-releases/9cd8c27088394e33/gowm-dev-server-0.7.1`
- 组合入口：`/mnt/data/gowm-analysis-current`，仍指向 `9f19951ac4ad691e/gowm-gdps-analysis-dev-server-0.1.0`。
- 迁移 080 校验和：`2e6dad5f1aff683a4e43561a50b1bb244df5cbebc78097847ab7e72495f160d4`。
- 18:18（北京时间）正式迁移并升级历史 Provider、投影工作器；其他46个现存容器ID、镜像和StartedAt保持不变。未改配置密码、未清空数据卷、未激活WSGS候选。
- 组合根 `deployment/build-compat.compose.json` 持久保存这两个服务和 migrate 的新镜像、构建目录；原覆盖项保留。升级备份和前后容器清单存于远端 release 目录。

## 根因与验证

原TRACE/MAP/CROSS SQLSTATE23503来自入队函数用 `gowm:wrf_*` 查原始主键；工作器的相同标识比较及上游任务算法配置处理一并修复。纯插值零原始样本的修订约束与073分段约束对齐，业务结果明确NO_DATA。

真实PostgreSQL18.6/PostGIS3.6.4/MobilityDB1.3、80条正式迁移验证通过：实际服务角色、命名空间与缺失引用负向、幂等、冻结快照、过期租约恢复、旧代fence、零样本落库及NO_DATA。真实HTTP Gateway→Provider回归通过（18次Gateway提交）；相关单元测试、类型检查通过；部署镜像797个源码文件与正式包一致。

现场原失败 `query_job_954c38557ac64edb85cf4a8347ac0eb7` 的冻结请求重放，保持 `capturedAt=2026-09-08T09:36:33.882Z` 和原manifestHash不变，现可正常入队，返回PARTIAL/PROJECTION_PENDING。工作器完成队列并保存PENDING/PROJECTION_PENDING outcome，**不是正向业务成功**。旧Gateway作业保持原样。现场已有3条零样本修订成功持久化。

已交接分析任务 `01a079cb-98c5-75d3-9a4f-16343cdaa6df` 串行接管共享环境统一复测，通知WSGS任务 `01a07a25-f370-7cf3-b17f-e473a2324b03`。后续使用新Gateway请求并保留120秒预算、身份签名、快照和生产资格检查；不将PARTIAL或NO_DATA当作成功。

## 081 PENDING 重评修复（18:50 上线）

五个新请求语义哈希相同。原CROSS冻结时点的只读输入加载READY（1条tracklet、17段、1条watermark）；另外四个快照缺少所选tracklet在capturedAt前的finalization。详见 pending-readonly-probe.jsonl。旧PENDING被永久复用属于独立代码缺陷。

081增加精确区间修订的读取重载，Provider将PENDING重新按冻结身份入队并避免旧PENDING覆盖已有有效轨迹。真实PG81回归、并发去重、旧结果不变、HTTP Gateway回归、7条Provider单元测试及类型检查均通过。

正式包SHA256 `bbd742ca1d200f9bf3fc0874f2a0b614e62222f1b02320c88087707d432f6931`；Provider镜像 `sha256:bf29c5641a7a689245f442b12bafe4938a6905249e2490ca04737f373922e5f5`；提交 `5712a4b`。远端目录 `/mnt/data/gowm-history-releases/bbd742ca1d200f9b/gowm-dev-server-0.7.1`。仅执行migrate及替换Provider，其他54容器不变。

原CROSS冻结请求实际新建队列 `e1aa68ce-a9a5-4075-8299-63639d598ed0`。旧outcome内容MD5 `cf15bfbddd14a85c5b8d55a713ba535e`、旧Gateway结果MD5 `cf83689153f38a3b5eb89174d511e922` 前后一致。

**未取得正向轨迹结果**：10:54:13 UTC新队列RUNNING/attempts2，lease_until为10:53:19（过期约54秒），工作器仍执行MobilityDB切片。067完成函数拒绝过期租约；coordinator批量认领后串行执行，当前没有续租。该独立执行时长/租约阻塞已通知分析任务；此次未改工作器或延长Gateway的120秒预算。仍不得激活失败WSGS候选。

## 082 租约修复与最终 CROSS 证据

迁移082增加受当前worker/generation及未过期条件约束的续租。工作器只认领立即执行的一条轨迹任务，生产续租使用独立小连接池，取消/失租阻止后续SQL与提交。原完成过期拒绝、原子回滚及Gateway120秒预算不变。真实PG82验证覆盖长SQL跨多个租约周期、单工作连接、等待任务未提前认领、续租失败、取消和新旧执行者并发接管；17条相关单元测试、3条协调器测试及类型检查通过。

同时发现基础projection-worker仍运行旧467b镜像并竞争同库，导致原CROSS最后一次重试出现旧标识错误。现两套工作器均已同步升级，停机后确认没有其他projection进程且旧worker数据库连接归零才恢复任务。

- 最新包SHA256：`53cea4cc0903e3b6fc5a84bb948a18ce3a6079244cde174c6946b1a6d216735e`；提交 `0766876`。
- 镜像：`sha256:ff41b7167f4c25df2278fad7ebcba02569d8b20a2a0ed6bd351e6bf2da9d65aa`。
- 远端release：`/mnt/data/gowm-history-releases/53cea4cc0903e3b6/gowm-dev-server-0.7.1`；原组合入口保持不变，build-compat持久绑定两个worker和migrate的新镜像/构建目录。
- 基础worker：`007bcf63206b`；world-platform worker：`b8b0d6f5b614`。其他54个容器ID、镜像、StartedAt保持不变。
- 082校验和：`52eede796db49c0b3aea64993ccd65e1ab53568ec40ed5171f9048d929a62902`。

原CROSS队列在授权后保存完整原元数据，使用带旧state/attempts/generation/token条件的原子更新，只恢复**一次**额外尝试。原10次历史尝试保留于审计；运行计数恢复到9后仅允许执行到原上限10，generation从10→11→新认领12，旧token不能提交。冻结字段SHA256始终为`2aafdd9e35d3d79e81106d814822eac12a031adbe8e2d30d9e5cd764403b2230`。详见`cross082-recovery-audit.json`，未全量重置、未无限重试。

**同一队列已COMPLETED并产出实际轨迹**：revision `25ac74bd-cca9-45eb-af9f-3a857954a36f`，引用`wrf_349f838c72fb4a25adbb6862dfc5ee1a@1`。历史读取角色通过v2接口核实原始测量4800条，具备observation/sourceTracklet来源链，evidenceHash=`sha256:21a414fe2e9ffe1597d651d530cde455ad45dbe38057b44a4d209659e777c9f6`。几何节点3106，14段、13处gap，覆盖率0.9978100632631166，PROVISIONAL。

Provider在新的捕获时点返回`PARTIAL/OPEN_EXECUTION`和实际轨迹引用；原CROSS预算maximumInlinePoints=0，所以空preview符合原输入。另一个只读新请求将预览预算改为8，确实返回8个点，首点2026-09-08T08:13:53.398Z、坐标106.814849175/29.718773448。未填补gap、未将PARTIAL作为完整场景验收通过。

已向分析任务与WSGS任务完成上游交接，由分析任务串行刷新联合包来源链并复测。此后不再变更共享实例。

## 最终 CI 与后续 MAP 只读结论

最新提交 `5407dbd` 的必需检查已通过：
https://github.com/zhouwen-giser/geospatial-operational-world-model/actions/runs/34221894574/job/102046725316

补充修复了旧架构断言硬编码单参数调用，以及当前历史证据CI仍固定迁移到075的问题。当前功能测试自动采用最新正式迁移，保留069基线和前缀校验和不变，fresh/069→082及幂等重放验证均通过。这些CI-only修改不改变已部署的53cea4包。

后续MAP `query_job_7334a7c7de174bbcbc63bc85e1f8df23` 只读核查为正常冻结资格等待：capture=11:33:15.717Z；tracklet `15cc6d32-e8dd-454b-929e-565b61d2705b` 创建于11:33:15.196733，首次finalization在11:33:19.500864，晚3.783864秒。队列`f8457f80-fef8-415e-b082-0f679457b60f`正常COMPLETED/attempts1/last_error空，保存PENDING/PROJECTION_PENDING，未复现租约/标识错误。未读取晚于捕获时点的证据来改写旧结果；详见map082-readonly-probe.jsonl。

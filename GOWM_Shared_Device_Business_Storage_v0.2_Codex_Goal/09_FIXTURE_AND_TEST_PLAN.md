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

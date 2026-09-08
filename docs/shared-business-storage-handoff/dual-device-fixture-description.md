# 双设备存储 Fixture

仅显式隔离 test 数据库和 smoke enable 可写。固定 TEST scope，两设备共用同一原生表；每台一个 Task、Point/Polygon、一个含 move/observe 节点的 Plan、3 个 Node Run（move 重试）、3 个 MCP Task、3 个 Execution、每个两个 Dispatch。每台一个 LINKED Mission 和一个 UNCERTAIN 回执；两台原生 mission ID=7、snapshot revision=1、source sequence=1、idempotency text=same-key。A 替换服务绑定，历史仍指向旧 binding。

fixture 创建在同一个 Repository 事务内；重复运行返回已知测试行。场景临时变更使用事务回滚，唯一并发用例仅清理其明确创建的 command_sequence=777。无 DROP SCHEMA、无运行数据回填、无设备或 MCP 网络调用。

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

# 21 — 测试与验收

完整矩阵位于 `acceptance/acceptance-matrix.csv`。

测试层级：

```text
Unit
Contract
SQL AST
PostgreSQL Integration
Projection Replay
Gateway/Provider Contract
Real Container E2E
Scope Adversarial
Migration Upgrade
Load/Recovery
```

必须真实证明：

- v0.2 代码和远端 SHA 对账；
- Reference 名称/别名/同名歧义；
- Layer/Feature 版本；
- DerivedReference/ReferenceSet TTL；
- OperationalTask 四维状态；
- Provider completed + physical unverified；
- 迟到事件不回退；
- NO_DATA 与 NOT_SUPPORTED；
- exact correlation 与 conflicting matches；
- fresh/upgrade/replay；
- Gateway/Provider/DB restart；
- 跨 Scope 无泄漏。

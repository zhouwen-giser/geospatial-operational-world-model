# 09 — v0.3 Grounding Ready 门禁

GOWM+ 只有满足以下条件才标记 `GROUNDING_READY`：

1. ReferenceKey 合同稳定；
2. Name/Alias/Code 实际可写、可查、可回放；
3. 同名道路返回多个候选而不随机选择；
4. Dataset/Layer/Feature 具有版本和 Scope；
5. Reference Resolve/Validate 通过 Gateway；
6. DerivedReference 和 ReferenceSet 可重放、分页、过期；
7. World State/Geometry/Provenance/Event Timeline 稳定；
8. WSGS 无需访问 Provider URL、数据库或内部 ID；
9. Capability Catalog 可发现所有 Stable/Preview Operation；
10. fresh/upgrade migration 与真实 PostgreSQL 验收通过。

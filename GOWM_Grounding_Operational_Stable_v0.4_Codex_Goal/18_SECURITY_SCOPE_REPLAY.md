# 18 — Security、Scope、Replay

## Scope

- 所有表含 DataScope；
- Gateway 传递签名 Scope；
- Provider 设置事务级 Scope；
- SQL Contract 再次过滤；
- 跨 Scope ReferenceKey 返回不可区分拒绝；
- 搜索结果不得泄露候选计数。

## Replay

必须支持：

```text
Reference Search Projection 重建
OperationalTask Snapshot 重建
Correlation Finding 重算
Predicate Evaluation 按冻结输入重放
```

重放必须记录：

```text
policy version
source event range
input/evidence hash
output checksum
difference report
```

## Security

- bounded text/name/alias；
- pg_trgm 候选上限；
- JSON 深度和大小；
- Cursor 签名；
- no arbitrary SQL/URL/tool；
- error/audit/trace 脱敏；
- immutable result/evidence records；
- late result 不覆盖 cancelled/expired result。

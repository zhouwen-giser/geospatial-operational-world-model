# 00 — 当前状态与续作协议

## 生成时远端状态

```text
repository: zhouwen-giser/geospatial-operational-world-model
branch: codex/gowm-capability-platform-v0.2
head: 1887e56a18b77aa9692cca9d86b00413906816f4
Draft PR: #1
```

该 Head 已包含 v0.2 大部分实现，包括合同、Gateway、Provider Bridge、
`gowm_spatial_v1`、Query Runtime、兼容层和安全测试。

## 已知状态冲突

部分 `PROJECT_STATUS.md`/P17 内容仍记录“实现未提交、候选 SHA 为空”，但远端
已经出现后续提交。Codex 必须：

1. fetch 所有 refs；
2. 获取 PR 当前 Head；
3. 检查 `git status`；
4. 比较代码、报告和实际提交；
5. 用新机器证据修正状态；
6. 不把旧 Blocker 文本当作当前 Git 真值；
7. 不删除旧报告，而是追加 reconciliation report。

## 如果已有 Codex 任务仍在工作

- 不争用同一工作树；
- 等其当前命令结束后再读取状态；
- 使用独立 worktree；
- 不移动、stash 或清理其他任务的修改；
- 只从 committed/pushed Head 创建 v0.3/v0.4 分支。

## C00 输出

```text
reports/gowm-v0.4/c00-source-reconciliation.md
reports/gowm-v0.4/c00-source-lock.json
reports/gowm-v0.4/sync-state.json
```

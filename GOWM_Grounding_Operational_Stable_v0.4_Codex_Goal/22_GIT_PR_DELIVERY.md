# 22 — Git、PR 与交付

## v0.2

继续使用：

```text
branch: codex/gowm-capability-platform-v0.2
PR: #1
```

仅完成对账、真实门禁和必要修复，不把 v0.3/v0.4 混入旧 PR。

## v0.3/v0.4

```text
branch: codex/gowm-grounding-operational-v0.4-stable
initial base: codex/gowm-capability-platform-v0.2
PR title: feat: add GOWM grounding and operational reality v0.4
```

如果用户合并 v0.2，允许通过 GitHub 更新 Base，不重写提交。

## 报告

```text
execplans/EP-gowm-grounding-operational-v0.4.md
reports/gowm-v0.4/sync-state.json
reports/gowm-v0.4/<phase>-completion.md
reports/gowm-v0.4/<phase>-acceptance.json
reports/gowm-v0.4/final-stable-candidate.md
```

## 禁止

- 自动 merge；
- Tag/Release；
- 生产部署；
- force-push/rebase 已发布历史；
- 覆盖其他任务工作树；
- 提交密钥和真实敏感数据；
- 修改 WSGS/SACS/SDAR/SMPP 仓库。

# GOWM+ v0.3–v0.4 Grounding & Operational Reality Codex Goal

状态：`READY_FOR_CODEX_GOAL`  
生成日期：2026-08-23  
目标仓库：`zhouwen-giser/geospatial-operational-world-model`  
续作基线：`codex/gowm-capability-platform-v0.2@1887e56a18b77aa9692cca9d86b00413906816f4`  
现有 Draft PR：`#1`  
目标分支：`codex/gowm-grounding-operational-v0.4-stable`  
最终软件版本：`0.4.0`

## 目标

基于已经部分完成的 Capability Platform v0.2，串行完成：

```text
v0.2 Capability Platform 收口
        ↓
v0.3 Grounding Foundation
        ↓
v0.4 Operational Reality
        ↓
GOWM+ 0.4.0 Stable Candidate
```

最终使 GOWM+ 成为可供后续 WSGS 稳定消费的：

```text
世界引用权威
世界数据集和图层目录
真实世界状态与证据平台
真实任务事件权威
计划外部条件的现实证据验证平台
```

本任务不实现 WSGS，也不修改 SACS 或 SDAR。

## 当前续作事实

v0.2 远端已经包含 Provider/Gateway 合同、Provider SDK、六 Provider Registry、
50 项能力、直接执行、类型化 DAG、Job、ReferenceKey、`gowm_spatial_v1`、
CRS/Geometry/H3/Spatial Bridge 及兼容层。当前主要缺口是实际状态对账、
真实 PostgreSQL/Provider/Docker/重启/Scope/负载验收，以及部分项目状态文件
仍描述旧的未提交边界。Codex 必须以执行时 Git 真值为准，不复制旧报告结论。

## 使用方式

```bash
bash scripts/preflight.sh .
python3 scripts/validate_task_package.py .
```

然后将 `CODEX_GOAL_PROMPT.md` 作为 Codex Goal 指令。

## 完成标志

所有 Required 门禁通过：

```text
GOWM_V0_4_STABLE_CANDIDATE_COMPLETE
```

只剩明确外部环境或受保护发布动作：

```text
GOWM_V0_4_STABLE_CANDIDATE_BLOCKED
```

Codex 不自动合并 PR、不创建 Tag/Release、不部署生产。

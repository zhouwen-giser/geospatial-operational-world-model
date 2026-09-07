# 提交前复核（2026-09-07）

用户授权：确认并提交本地有效修改、纳入历史有效修改、推送并发起目标 main 的
合并请求；不直接合并 main，不发布、不修改运行环境。

## 提交范围

- 保留基线 `77f7df4` 及其相对 GitHub main 未合入的 21 个 OpenDRIVE、UGV、
  部署修复历史提交，不 squash 或删除历史证据。
- `68547fe`：本轮 28 个文件，原始采样 v2、UNKNOWN、mapper/QoS0、调度、索引、
  固定 Schema、默认配置、回归与诚实验收记录。
- `cc11cb4`：整合 GitHub main `61082e5`。解决 packager 冲突，同时保留仅跟踪
  文件入包、递归排除 tests/reports/普通 fixtures/examples、OpenDRIVE 精确白名单、
  可复现归档和权限检查。新增白名单文件必须受 Git 跟踪的检查。
- `e3901ab`：保留 GitLab main `c198369` 的同步历史；没有改写现有 main 分支。
- 分析仓库仍在其原工作分支，有大量本轮开始前的交叉修改。本 PR 不包含该仓库
  的未提交工作；联合验收/交付依赖它的独立审查与提交。

## 本次复核结果

- 当前树 npm run check PASS；迁移 001–068 冻结、合同/类型、架构门禁 PASS。
- 历史证据/UGV/finalization/redelivery：45 tests PASS。
- OpenDRIVE/路网/独立 verifier 相关：51 tests PASS。
- tracked-only 打包清单、LF、非默认宿主探测：7 tests PASS。
- 新整合几何修复：重建 geometry-tool-service 后 6 tests PASS。
  最初旧 dist 导致 4 项失败；更新编译产物后全部通过，未放宽断言。
- build:runtime PASS；环境模板 205 个 Compose/178 个 runtime 变量审计 PASS。
- 本轮之前的隔离 PostgreSQL/MobilityDB 及 MQTT 验收见 IMPLEMENTATION_REPORT；
  本次未伪装为重新运行现场或全量数据库故障矩阵。
- 与 `77f7df4` 相比 output/deployment 无字节变化：累计 PR 包含历史已提交的
  部署包，但没有将它标成包含新 history v2 功能的发布包。正式重包需后续交付。

## 合并边界

这是累计源代码 PR，与已有 OpenDRIVE PR #19 有重叠，审查时避免重复合并。
未关闭旧 PR，未开启自动合并。现场原始数据/真实大表性能/完整调度与 broker
升级故障矩阵仍未宣称 PASS；既有已知事项保持原证据和声明范围。

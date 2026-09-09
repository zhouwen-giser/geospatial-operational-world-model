# GOWM 上线后唯一一次正常历史请求验收

2026-09-09T11:57:18.540Z–11:58:13.806Z。经 GOWM 任务明确通知上线完成后，通过正常 SACS AG-UI→WSGS 路径，仅提交1次请求，deadline=120000ms，契约1.2。没有补发或调用Provider诊断接口，没有修改GOWM。

## 结论

**有效 HISTORICAL_TRACE Finding 验收未通过，整体仍 INCOMPLETE。** GOWM 已返回真实轨迹，本次不再是投影等待；新的阻塞位于 WSGS 公开结果装配，缺少轨迹主体的 WORLD_OBJECT 引用产品，导致 REFERENCE_MISSING。

1. 1.2能力预检通过，所有声明的分析能力available=true。
2. 单次POST202/ACCEPTED；SACS HTTP200、RUN_FINISHED，无RUN_ERROR，持久化状态快照经 parseAndVerifyAgUiSharedStateV03 验证，临时数据库cleanup PASS。
3. 最终PARTIAL，findingCount=0、choiceCount=0、unresolvedMentionCount=0，gapKinds=[REFERENCE_MISSING]。测试程序保留INCOMPLETE/OBSERVED及退出码2，没有改写成业务PASS。
4. 只读解密并校验本次检查点：完整性通过，公开结果schema通过（0错误），resultHash校验通过。原任务提及RESOLVED_EXACT，引用验证VALID、revalidationRequired=false，validUntil=11:59:10.031Z，晚于本次响应完成时间；没有复用先前已过期的验证租期。
5. 区间节点11:58:10.399Z–10.458Z COMPLETED / INTERVALS_AVAILABLE。历史节点11:58:10.470Z–11.948Z PARTIAL / TRAJECTORY_GAP，耗时约1478ms。
6. 历史结果为PROVISIONAL，9806个样本、1个真实缺口。最终公开引用产品包含OPERATIONAL_TASK、HISTORICAL_TRAJECTORY、TASK_EXECUTION_INTERVAL；均与历史结果对应完整引用匹配。历史主体WORLD_OBJECT则既无完整引用匹配，也无逻辑身份匹配。

`projectPublicWorldAnalysis` 的历史Finding基础字段要求主体引用产品；生产装配添加了轨迹与执行区间引用，却没有将任务间接解析出的主体提供为公开引用产品。此检查阻止了缺少主体来源的Finding，不能通过删除引用检查或伪造可信引用绕过。本轮只定位，不额外修复或再次验收。

## 关联摘要

- groundingIdHash：sha256:0cfa8a669894c2a103c438c46ae16fc08bdb1abe2f09c8a0d5752ac0320d093c。
- resultHash：sha256:57b18b6cca3d9c25a8fb6c8ccf8cee4ec46f5ee2d0f53162cec41208a3252e56。
- semanticRequestHash：sha256:4d478177325b690f18158ca33dede96b50b2addc3f4d3d79efbf2e09a95a2b27。
- 历史节点effectiveSnapshotBeforeHash：sha256:64a134d18eb32f4c245a94076d3d013271c4e70d4d293eab587f5aa3c1cbf0bb。
- 缺失主体完整ReferenceKey摘要：sha256:d1372d1f0cb62485dd8411b4bc2db4050ac7ff9f8db91b4ca33fbc8616cbf5e9。
- 轨迹完整ReferenceKey摘要：sha256:58d447dd058b7ab0c21af07d085437eff4564d7abed9b1f99cd4739f37054420。

输入仍采用此前私有文件、单个任务和历史请求。现有路径使用LATEST + EXECUTION_ENVELOPE，不能宣称自由起止时间窗验收通过。保留真实缺口和PROVISIONAL；GOWM返回轨迹成功不等于WSGS Finding与完整端到端业务通过。

证据：INTEGRATION_EVIDENCE.json；只读检查点诊断脚本checkpoint-inspect.mjs。诊断仅输出状态、计数、时间与摘要，未导出业务原文、坐标、密钥或模型推理。

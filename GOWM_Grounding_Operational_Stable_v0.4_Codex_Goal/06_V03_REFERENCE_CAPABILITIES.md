# 06 — v0.3 Reference Capability Provider

新增 Provider：

```text
providerId: gowm.reference-catalog
```

注册：

```text
reference.get
reference.resolve
reference.validate
reference.batch-get
reference.search

dataset.get
dataset.list
layer.get
layer.list
layer.find-features
feature.get
```

## Resolve 输入

WSGS 将来负责 Mention 提取；GOWM 只接收结构化 Mention：

```text
mentionId
surfaceText
expectedKinds
semanticRole
anchorReferenceKeys
mapViewport
limit
```

## Resolve 输出

```text
status
candidate ReferenceDescriptor
matchedBy
matchScore
stateQuality
version
geometrySummary
provenance
```

状态：

```text
RESOLVED_EXACT
SUGGESTED_UNIQUE
AMBIGUOUS
UNRESOLVED
INVALID
```

GOWM 不决定用户是否接受候选，也不返回 `shouldForwardToSdar`。

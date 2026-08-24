# GOWM Provider Conformance Kit

The kit exercises a provider through the frozen protocol. Passing construction
alone is insufficient: it checks a real invocation, schema locks, strict input,
deadline, output budget, trusted scope, receipts/snapshots, and idempotent replay.
Static bridge-boundary checks are run separately by `validate:boundaries`.

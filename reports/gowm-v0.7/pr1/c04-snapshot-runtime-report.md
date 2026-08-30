# PR-1 snapshot runtime report

Technical result: `4/4` Effective Snapshot runtime tests passed. Resolver
discovery was persisted, the exact pin reached a downstream consumer, strict
conflicts failed without changing state, Best Effort retained the prior pin and
reported an explicit mismatch, and async resumption reloaded stored state.

The current PR-2 final candidate independently re-executed these child gates on
the stacked source, but that is not substituted for exact PR-1 publication
evidence. Exact PR-1 command timestamps/raw artifact were not retained; status is
`PARTIAL_EVIDENCE` under the task-package evidence rule.

# P09 — Generated WSGS southbound lock

Generator and contract tests: PASS. Stable admission intentionally pending P10.

The generated lock contains only operation/version, input/output schema hashes, semantic profile hash and maturity, plus the content-addressed catalog revisions. Preview has a separate 99-operation section; the two Experimental operations are excluded. The default list is currently empty because none of the 21 Stable operations is admitted without fresh real black-box evidence. No maturity was downgraded.

The normal generate/check command fails until all semantic gates pass. The explicitly named development-only --allow-pending mode materializes the fail-closed empty default list. The final artifact will be regenerated without that option after P10/P11.

Evidence: p08-p09-contract-tests.json (45 passing targeted tests), contracts/consumers/wsgs-southbound-operation-lock-v1.json, config/consumers/wsgs.env.example. Tests prove gate-dependent admission, preview segregation, Experimental exclusion, deterministic sorting, complete hashes, topology/secret exclusion and rejection of absent profiles. The admission-dependent lock is excluded from the implementation fingerprint to avoid a circular dependency; its contents and hash are checked independently by the lock gate.

Additional admission guard validation: the task-package status vocabulary used string terms and only four constraints; complete definitions were added for all eight statuses without altering any existing constraint. The gate accepts both vocabulary encodings and rejects changed meanings. Exact verification now checks retained GeoJSON type compatibility instead of merely checking that two input paths exist. p09-unit-results.json records 28 passing tests, and check/lock validation passed.

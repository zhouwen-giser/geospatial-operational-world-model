# PR-1 contract report

Technical result: snapshot contract tests `39/39` passed on exact PR-1 candidate
`835074d2aaf9b0eb58f03d381269f2610a624d13`. Frozen v0.6.3 payloads remained
valid; requested/effective pairing, descriptor semantics, additive historical
reference kinds and strict historical query/result shapes were covered.

The exact-head command was `npm.cmd run validate:v07-pr1`. Its terminal result
was observed in this task, but exact UTC command boundaries and a durable raw
command artifact were not retained. Under the package evidence rule this report
therefore remains `PARTIAL_EVIDENCE` even though the technical assertions passed.
The exact schema hashes are recorded separately.

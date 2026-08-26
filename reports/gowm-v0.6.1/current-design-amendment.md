# Current-design amendment — user-authorized scope

The user explicitly instructed: “继续完成任务，注意：当前没有旧数据，不需要兼容旧版本设计和数据，可以移除过时的内容”.

This overrides the task package's old-wire/old-data compatibility requirements.
It does not relax correctness, authoritative reads, scope isolation, real
runtime testing, honest evidence or protected-action prohibitions.

## Effective delivery

- One current owner and contract for each operation. Remove obsolete duplicate
  Reference/Result Validation routes from catalog/evidence providers; do not
  retain a second legacy implementation or add a compatibility adapter.
- Correct current Reference/Result/Snapshot validation across real authoritative
  records, including current RoutingSnapshot changes, retirement and expiry.
- Clean-install migrations, transactional rollback and deterministic replay are
  required. Old-data upgrades and byte-identical obsolete operation schemas are
  no longer acceptance requirements. Keep migration ordering unless a specific
  cleanup requires changing it; do not rewrite history merely for aesthetics.
- No fake legacy compute identity and no compatibility-driven conflation of
  no-feasible outcomes with NO_DATA. Source and normalized semantics stay explicit.
- Conformance must inspect executable current manifests, resolve every schema
  and compare its actual hash, and check co-registration of all current providers.
- Required real-runtime scenarios must execute PostgreSQL-backed authorities.
  In-memory cases may supplement them only as clearly labelled unit tests.
- The original acceptance matrix remains traceable; superseded compatibility
  requirements must be recorded as superseded by this user instruction, never
  silently counted as PASS or mistaken for an unrun current requirement.

## Withdrawn completion

The prior 229/229 receipt for 5029bce is insufficient: the audit reproduced
duplicate result.validate@1.0 ownership, stale query results returning
CURRENT/YES, fixture-backed validation scenarios and schema-hash false positives.
Historical reports are retained for provenance but do not certify this revision.
The final matrix, source lock and PR Ready decision must be generated again.

## Still excluded

WSGS readiness/client work, independent Data Platform Readiness, mock ELEVATION
onboarding, SACS/SDAR/A2A changes, merge, tag/release and deployment.

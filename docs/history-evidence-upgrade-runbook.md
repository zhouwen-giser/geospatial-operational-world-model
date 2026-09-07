# History / UGV repair upgrade runbook

This change is local implementation, not authorization to mutate a deployed
instance. Never run the disposable acceptance script against a real `gowm` DB.
No historical observations, bindings, time solutions or old results are backfilled.

## Defaults and migrations

- Run the standard migration entry point, not individual SQL files. Migrations
  071–075 add the v2 reader, UNKNOWN bootstrap, v2 projection profile, native
  scheduler and binding snapshot index. Frozen historical migrations are unchanged.
- Supply a distinct `HISTORY_AUTO_DB_PASSWORD`. Compose derives the dedicated
  `HISTORY_AUTO_DATABASE_URL`; neither analysis nor scheduler needs an admin URL.
- Native scheduler defaults: enabled, owner `gowm`, 60 seconds, 16 candidates,
  Scope `default`, OPEN or last-seven-day CLOSED UGV chassis/recon tasks. Device
  and source come from the same UGV configuration. Unsupported/ambiguous ownership
  does not authorize time-overlap association.
- `GOWM_HISTORY_AUTO_OWNER=external` or `GOWM_HISTORY_AUTO_ENABLED=false` disables
  native enqueueing. Unknown owner strings fail. `GOWM_HISTORY_AUTO_TAKEOVER=false`
  refuses an existing outer checkpoint table until explicit handover.
- `UGV_MQTT_SPEED_QOS0_COMPAT=false` in the generic template. The authorized airport
  analysis bundle selects true. Only `/ugv/speed` may then pass QoS0; other QoS0
  packets are durably recorded as contract conflicts, not projected. Actual QoS,
  policy version and BEST_EFFORT_NO_PUBACK remain visible.
- UNKNOWN is created only from a valid measurement/datastream/producer/clock
  relationship. An absent lateness declaration is UNKNOWN-only, not a zero-loss
  guarantee. A policy can be declared in `gowm_history.stream_bootstrap_policy` by
  an authorized administrator. Existing watermark authority is never downgraded.
  A changed incompatible clock cannot seal a tracklet with the old clock evidence.

## Ordered handover (requires instance-specific execution authorization)

1. Back up and record instance identity, application image, input capabilities,
   migration level, current immutable hashes and queue counts.
2. Disable the outer scheduler, wait for it to cease enqueueing, and drain its
   already-enqueued work. Keep its checkpoint table for audit. Do not import the
   old weak signatures. Both implementations share the legacy Scope advisory lock.
3. For mapper v2, pause the upstream publishers under operator coordination.
   Leave the old receiver/mapper running until persistent MQTT backlog, inbox
   RECEIVED/VALIDATED/OUTBOXED and outbox PENDING are zero. Investigate dead letters;
   do not silently classify them as delivered. Stop the old receiver. Reset only
   its verified broker persistent session through the broker's supported procedure
   while publishing is still paused; retain the same client identity. Do not evade
   the pending-context gate by inventing a new client ID. The application refuses
   context changes with an active session or incompatible pending inbox.
4. Apply migrations. On an existing nonempty binding table, the runner performs
   CREATE INDEX CONCURRENTLY outside the SQL transaction. An equivalent valid
   outer index is reused by definition, not name. Only a known invalid matching
   index may be dropped/rebuilt. Lock/budget failure aborts; never blindly retry
   a different definition or put CONCURRENTLY inside BEGIN.
5. Start the new mapper context/epoch, verify same vehicle/session SPEED and GNSS,
   then resume publishing. Old inboxes continue to use their stored mapper context.
6. Remove source overlays only after native capabilities are verified. Start the
   sole native scheduler with explicit takeover acknowledgment for upgraded outer
   databases. Inspect checkpoint outcomes, queue state, actual output timestamps,
   PROVISIONAL status and the health file, not merely container liveness.
7. Recompute analysis using the v2 evidence adapter. Preserve STOP/Gap thresholds.
   T4 DISTINCT ON/MATERIALIZED SQL remains owned by the analysis repository.

## Validation and rollback

`npm run validate:history-evidence` requires DATABASE_URL with a disposable
`gowm_history_repair_*` database fully migrated and seeded with normal foundations.
Set `ANALYSIS_SRID=32648` for this fixed airport test when migrating and running it.
It writes synthetic original observations, exercises the real worker and scheduler,
and checks 197 evidence samples / two nodes, UNKNOWN, PROVISIONAL, paging, late
data isolation, reader permissions and cursor/Scope denial. It is not site replay.
The sibling analysis test `tests/history-original-samples.test.ts` uses
HISTORY_EVIDENCE_TEST_DATABASE_URL for STOP, 398/4 alignment and independent
five-minute/15ms counterexamples. That test skips if its URL is absent: a skip is
not real-database acceptance.

Before declaring site acceptance, replay the exact authorized source snapshot,
including its actual endpoint convention; record original IDs and evidence hashes,
the two false compressed breaks, true five-minute Gap, 15ms anomaly, STOP and all
402 actual metrics. Capture the real binding-table cardinality and EXPLAIN
(ANALYZE,BUFFERS) under the configured query deadline. Local synthetic timings do
not establish the site's performance or STOP outcome.

Rollback disables native scheduling and restores a compatible application; retain
all additive evidence and old contracts. Do not delete evidence to reverse an
upgrade and do not reactivate geometry-node sampling as a compatibility fallback.
Future releases must come from clean committed trees: new GOWM archive, GDPS
rebuild, analysis dynamic capability/checksum discovery, then a deployment-specific
exact dependency lock. Baseline hashes are provenance only. No archive is rebuilt
or published as part of this local change.

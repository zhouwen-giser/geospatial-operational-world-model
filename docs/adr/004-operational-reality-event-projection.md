# ADR 004: Operational Reality event and projection contract

Status: Accepted

## Context

Provider completion, external task status, observed activity, physical effect,
and sensor coverage are different claims. Collapsing them into one task status
would turn control-plane reports into unsupported physical truth and make late
or conflicting evidence impossible to replay correctly.

## Decision

- `OperationalTaskEvent` is the immutable authority. Event identity and
  external source revision are idempotency boundaries; late receipt never
  changes event time and never mutates an accepted event.
- `OperationalTaskSnapshot` is a rebuildable projection with four independent
  dimensions: control state, activity state, outcome verification, and
  observability. Projection order is deterministic by event time, received
  time, and immutable event identity.
- Provider `COMPLETED` may produce `COMPLETED_REPORTED`; it cannot produce
  `VERIFIED` without separate physical evidence. Missing evidence remains
  `UNVERIFIED`, `INDETERMINATE`, or `NO_DATA` as the relevant contract requires.
- External correlation claims are preserved as evidence. Explicit propagated
  IDs, Provider declarations, and manual confirmations outrank bounded derived
  resource/time or spatiotemporal inference. Conflicts and non-matches are
  append-only findings, not discarded search failures.
- Predicate evaluation is a frozen-input evidence computation. Supporting and
  contradicting evidence, assumptions, observability assessment, method
  version, and evaluated WorldVersion are mandatory replay material.
- Observability is evaluated from source health, coverage, watermarks, gaps,
  and freshness. Lack of coverage cannot be interpreted as evidence that an
  event did not occur.
- The canonical `gowm.operational-reality` Provider is read-only. It exposes the
  eight frozen operations through versioned SQL contracts; event ingestion,
  projection, replay, and outbox publication remain Foundation-owned writes.

## Consequences

Operational source events, correlation findings, predicate evaluations, and
replay receipts are append-only. Snapshots and indexes may be rebuilt and
atomically replaced. All tables and queries are DataScope-bound before match,
rank, count, or pagination. The Gateway continues to route and orchestrate; it
does not implement operational truth, correlation, or predicate semantics.

# O10 Operational Reality Acceptance

## Decision

`PASS — OPERATIONAL_REALITY_READY`

The v0.4 Operational Reality path is proven through the production Gateway DAG
runtime, the independently served Provider Protocol HTTP endpoint, and real
PostgreSQL persistence.

## Acceptance evidence

- a correlation DAG binds the Provider-declared
  `operationalTaskReferenceKey` selector into
  `operational-task.get-timeline` and returns the seeded immutable event;
- a predicate DAG evaluates `EVENT_OCCURRED`, gates observability on the
  controlled `status` selector, then loads the operational state only when
  observability is `FRESH`;
- replaying the same predicate DAG returns the byte-identical persisted result;
- an asynchronously queued operational job is claimed and completed by a new
  Gateway runtime after the first listener is closed;
- a real Provider HTTP result is held after computation, cancellation is
  persisted, and the late result cannot overwrite the `CANCELLED` node or job;
- the boundary validator forbids Gateway imports of Operational Reality domain
  repositories or Provider implementation code.

Run with:

```text
DATABASE_URL=<postgresql-url> npm run validate:operational-ready
```

The phase also passes `CAPABILITY_BOUNDARIES_PASS` and the full repository
verification suite: 117 Vitest assertions (one declared environment skip), all
39 STAS assertions, SQL AST checks, type checks, and production builds.

The locked C02 prerequisites AC-C007 and AC-C008 remain `BLOCKED_EXTERNAL` and
are not represented as passing.

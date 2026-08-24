# World Capability Gateway

This service owns identity/scope enforcement, controlled registry resolution,
budgets, idempotency, provider routing, circuit breaking, persistence, receipts,
audit, and query orchestration. It deliberately contains no CRS, Geometry, H3,
PostGIS, MobilityDB, or other domain engine.

Provider base URLs are supplied only by approved deployment configuration. They
are not accepted in an execute request or a query plan.

# GOWM Operational Reality Provider

This independently deployable Provider exposes the frozen v0.4 Operational
Reality operations through Capability Provider Protocol v1. It accepts Scope
only from Gateway security context; external correlation identifiers and
predicates remain query inputs rather than Foundation identities or facts.

Required runtime variables are `OPERATIONAL_REALITY_DATABASE_URL` and
`PROVIDER_TRANSPORT_SHARED_TOKEN`. The default listener is port `8094`.

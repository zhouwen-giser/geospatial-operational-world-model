# GOWM grounding catalog provider

One hardened implementation serves either canonical provider identity through
`GROUNDING_CATALOG_MODE=reference|dataset`. Both modes use only their versioned
SQL read contract, scope the repeatable-read transaction before querying, and
emit scope-bound snapshots. Dataset mode requires both trusted data-scope and
dataset-scope claims.

Runtime configuration requires `GROUNDING_CATALOG_DATABASE_URL`,
`GROUNDING_CATALOG_CURSOR_HMAC_SECRET`, and `PROVIDER_TRANSPORT_SHARED_TOKEN`.
Use the `gowm_reference_service` login for reference mode and
`gowm_catalog_service` for dataset mode.

# ADR 062: Unified World Platform Gateway and explicit semantics

## Decision
Provider Execution Protocol stays 1.0. Manifest Schema 1.1 is independently versioned and requires a controlled semanticProfile on every capability. Legacy 1.0 remains parseable only for development direct execution; its operations are omitted from the semantic catalog. The world-platform registry requires 1.1.

Provider-owned semantic source contracts, schema/port evidence, implementation symbols, SQL AST, tests and bridge source locks feed an offline deterministic materializer. No missing-field default, operation prefix classifier, provider-name inference or runtime override is permitted. Unknown semantics remain unresolved; Stable requires static, cross-capability and freshly executed black-box evidence. Maturity changes require an attested reason.

Gateway performs validation, registration, pure projection and content hashing. Contract revision includes complete descriptors and vocabulary definitions, excluding endpoint, health and implementation identity. Binding revision includes provider version, implementation digest, manifest hash and approval ID. Registry order and restart are immaterial. Provider health is operational state, never contract identity.

A generated controlled registry combines approved fragments. An isolated Compose profile publishes only the Gateway. WSGS consumes one GOWM_GATEWAY_BASE_URL and a generated topology-free lock; default entries require Stable evidence, preview entries stay separate. Providers neither call sibling providers nor move algorithms into the Gateway. STAS needs a thin protocol adapter calling the existing native service in-process, with no new analysis algorithms.

Canonical facts and all existing GIS, H3, routing, coverage and STAS algorithms remain unchanged. NO_DATA is unknown; infeasible planning is a domain result, not an infrastructure failure. Candidate indexing never proves an exact geometric fact. Exact verification retains the original geometry when candidate cell output alone is insufficient.

## Compatibility
Existing execution/result/job/health contracts and legacy direct/DAG profiles remain supported. Semantic catalog schema advances to 1.1 with explicit nested profiles and hashes. No external URL, credential, SQL or container topology is exposed in the consumer operation lock. No merge, tag, release or production deployment.

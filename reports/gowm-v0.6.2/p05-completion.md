# P05 — Gateway pure semantic projection

Removed runtime semantic overrides, prefix dispatch, provider-name guessing and default profiles. Both catalog endpoints project validated explicit Manifest 1.1 profiles. Legacy manifests remain directly routable only in legacy registries and are omitted from semantic catalogs. World Platform configuration and registration fail closed for missing or legacy semantic contracts.

The catalog response now carries content revisions (P06); old registryVersion remains an alias, and legacy registry-N response parsing remains compatible. Existing Provider protocol schemas and algorithm implementations are unchanged.

Executed 16 Gateway/projection/hash tests and complete root/native STAS typecheck. Evidence: p05-p06-unit-results.json. Runtime and full Stable gates remain pending.

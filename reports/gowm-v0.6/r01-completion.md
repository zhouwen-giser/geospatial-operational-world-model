# R01 Source Lock, License, and Clean-room Map Completion

## Phase / Scope

R01 locks the supplied reference archive, inspects its inventory and license boundary, and freezes selective clean-room reuse decisions. It imports no reference source.

## Source state

- Archive SHA-256: `a8b04ac9a6d6660d3042f4ba9030b0bb0b99b11a8f301a47dbfd12c8796ce116`
- Inventory: 1,337 entries, 39,214,103 uncompressed bytes, no unsafe absolute or parent-traversal path
- Root license: absent; effective status `UNSPECIFIED`
- Decision: `REFERENCE_ONLY_SELECTIVE_REIMPLEMENTATION`; redistribution denied
- Exact mapped concept-reference files: 22, all present and individually hashed

## Contracts / migrations

No contract or migration changes are part of R01. The source policy mandates actual v0.5 Network/Gateway authorities and rejects a second graph, legacy planner database, and Provider-to-Provider HTTP.

## Tests actually run

| command | result | evidence |
|---|---|---|
| task-package preflight | PASS | archive hash matched locked SHA-256 |
| .NET ZipArchive inventory and mapped-file hashing | PASS | 1,337 entries, 22/22 selective files found, zero unsafe paths |
| `npm.cmd run validate:gowm-v06-source-policy` | PASS | license, redistribution, mandatory authority, and exclusion markers enforced |
| `npm.cmd run validate:gowm-v06-predecessor` | PASS | 47 migrations and 9 predecessor contracts remain locked |
| `npm.cmd run check` and `npm.cmd test` | PASS | TypeScript/STAS typecheck and 163 regression tests; one pre-existing optional skip |

## Acceptance IDs

`AC-B009` now passes. Together R00 and R01 pass all `AC-B001..AC-B012` with no failure, blocker, or Required `NOT_RUN`.

## Authority / scope review

`V0_5_NETWORK_AUTHORITY`, `NO_SECOND_GRAPH`, and `NO_PROVIDER_TO_PROVIDER_HTTP` are permanent source-policy gates. OR-Tools, fleet, capacity, time windows, multi-route, legacy auth/database/contracts, generated output, `.env`, and prior gate conclusions are excluded.

## Failed attempts

The first archive listing was intentionally read-only but too verbose and was truncated in terminal output. A structured ZipArchive inventory then produced bounded, machine-readable counts and hashes without extracting the archive.

## Commit / push / PR

R01 is delivered as a semantic phase commit on the stacked v0.6 branch. The Draft PR body is updated after push.

## Blockers / Next

No source or license blocker under the reference-only decision. Proceed to A00 architecture authority/non-goals.

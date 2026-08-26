# R00 Main Reconciliation

The fetched `origin/main` and local `main` both resolve to
`7cd5b133a74b07e28f359176dd13943ab7a6cf54`. The repository version and package
version are `0.6.0`; migrations 001 through 053 are present. No tracked user
changes were touched. The uploaded task package remains outside the candidate
worktree, and implementation is isolated in `/tmp/gowm-platform-hardening-v0.6.1`.

Baseline `npm run check` passed. `npm test` passed 237 tests with one optional
skip when rerun with loopback listening permitted. The first sandboxed run is
retained as an environmental failure: 236 passed and one MCP scenario could not
bind `127.0.0.1` (`EPERM`).

`PROJECT_STATUS.md` is historical v0.6 text and will be reconciled in S02 after
the v0.6.1 gates have factual evidence; it will not claim completion early.

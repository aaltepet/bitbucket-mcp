# Changelog

## Unreleased

- Hardened credential logging: Winston redacts Authorization headers/tokens; tool call logs no longer dump argument values.
- Allowlist pagination `next` URLs to the configured Bitbucket API origin to prevent auth-header forwarding to attacker hosts.
- Widened `BITBUCKET_ENABLE_DANGEROUS` gating: only read-only tools are enabled by default; merges, PR writes, comments, pipelines, deletes, and branching-model updates require the flag.
- Encode dynamic API path segments and escape Bitbucket query filter values.
- Pin `mcp-publisher` to release `v1.7.9` in the publish workflow (no `/releases/latest`).
- Added a shared Bitbucket Cloud pagination helper and applied it across all list-style MCP tools so `pagelen`, `page`, and `all` arguments respect Bitbucket limits and `next` links (#37).
- Updated tool schemas, README documentation, and logging to describe the new pagination controls and to highlight the 1,000-item safety cap for `all=true`.
- Added Jest tests covering the pagination helper, including explicit `pagelen` requests, maximum page sizing, and automatic traversal of `next` links.

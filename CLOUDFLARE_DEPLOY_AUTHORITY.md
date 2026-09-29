# Cloudflare Public-Owner Deployment Authority

Canonical public-owner account:

`1b26415802588185a86c1d4d3ebf5bdb`

The production deploy workflow prefers the repository secret:

`CLOUDFLARE_PUBLIC_OWNER_API_TOKEN`

and falls back to the legacy `CLOUDFLARE_API_TOKEN` only for compatibility.

The token must be scoped to the canonical public-owner account. Before any mutation, the deployment gate verifies that the token can access that account.

Required authority for the current pipeline:
- deploy/update the existing `zevanory` Worker;
- read Worker settings and list Workers;
- read/write Workers KV where the workflow performs direct KV operations;
- Workers Routes Write for affected public zones if a Route or Custom Domain must be changed.

Fail-closed invariant:
- a token scoped only to another Cloudflare account MUST NOT deploy or masquerade as canonical production;
- no alternate account may be treated as production;
- failed authority verification leaves production unchanged.

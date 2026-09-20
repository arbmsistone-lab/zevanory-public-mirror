# Cloudflare deployment contract

This repository is the deterministic source of the ZEVANORY public static catalog.

## Safety boundary

The existing production Worker `zevanory` owns API behavior and bindings. It must not be replaced by the static-site Git integration until its Worker source, service bindings, secrets and compatibility settings have been reconciled and independently validated.

The Git integration in this repository is therefore deliberately named `zevanory-git-reproducible`. It publishes static assets only.

## Commercial fail-closed policy

Every Git-driven deployment must keep these values false:

- `ZEVANORY_PUBLIC_SALES`
- `CHECKOUT_ENABLED`
- `FINANCIAL_EVENTS_ENABLED`
- `PRE_SALE_GATES_APPROVED`
- `ABSOLUTE_RELEASE_APPROVED`

No checkout, payment event, commercial release or sales activation may be inferred from a successful static deployment.

## Production cutover

Do not route `zevanory.api.br/*` to `zevanory-git-reproducible` while the existing `zevanory` Worker is responsible for `/api/*`.

A production cutover is permitted only after:

1. the production Worker source and all bindings are represented reproducibly in Git;
2. exact-SHA remote gates pass;
3. API and static assets pass independent probes;
4. official and edge content identity is proven;
5. all commercial flags remain false.

This contract is fail-closed by design.

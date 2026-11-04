# Card gateway API — integration notes (internal wiki)

- `POST /v1/charges` creates and captures a charge. It is **not idempotent** by default.
- The gateway supports an `Idempotency-Key` request header. Requests repeated with the
  same key within 24h return the original charge instead of creating a new one.
- A client-side timeout does not mean the charge failed: the gateway may still complete it.
  Reconcile with `GET /v1/charges?metadata.orderId=...` before retrying a create.
- `GET` endpoints are safe to retry.

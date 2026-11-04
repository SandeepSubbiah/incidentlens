---
name: connection-pool-exhaustion
kind: runbook
description: Database connection pool exhaustion (HikariCP) causing request timeouts, and how long connection hold times cause it.
tags: [hikari, hikaricp, connection-pool, database, jdbc, timeout, waiting, sqltransientconnectionexception]
---
# Connection pool exhaustion

## Symptoms
- `HikariPool-1 - Connection is not available, request timed out after 30000ms`.
- Pool stats with `active` equal to `total` and a growing `waiting` count.
- Latency jumps to roughly the pool `connection-timeout`; errors arrive in waves.

## Diagnose
1. Throughput a pool can serve is about pool_size / average_hold_time. Find what made hold time
   grow, not only what made traffic grow.
2. In traces, look at what happens between connection checkout and commit. Any remote call in
   that window holds a connection for its whole duration.
3. Check recent changes that moved work inside a transaction or added calls to a slow
   dependency.
4. Check whether a downstream dependency got slower at the same time (it often triggers the
   incident, but the design flaw is holding the connection).

## Common causes
- Remote HTTP or messaging calls inside `@Transactional` methods.
- Long-running queries or lock waits.
- Connection leaks (not closed on an error path).
- Pool too small for the thread count after a scale-up.

## Fix
- Move remote calls outside the transaction; keep transactions short and database-only.
- Add a client timeout shorter than the pool timeout for dependencies called from request paths.
- Enable `leak-detection-threshold` to catch leaks.

## Red herrings
- Scaling out pods multiplies connections and can overload the database instead of helping.

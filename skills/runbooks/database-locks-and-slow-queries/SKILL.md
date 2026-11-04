---
name: database-locks-and-slow-queries
kind: runbook
description: Lock contention, missing indexes and slow-query logs; telling a real database bottleneck from background noise.
tags: [database, postgres, locks, slow-query, index, contention, deadlock, sql]
---
# Database locks and slow queries

## Symptoms
- Slow-query log entries, lock-wait timeouts, deadlock errors.
- Rising query latency with normal application CPU.

## Diagnose
1. Compare slow-query frequency and duration before and during the incident; a steady trickle
   of 500-700 ms queries usually predates it.
2. Check `pg_stat_activity` or equivalent for blocked sessions and long transactions.
3. Look for schema migrations, new queries or missing indexes deployed in the window.

## Common causes
- A migration taking an exclusive lock on a hot table.
- A new query without an index on a large table.
- Long transactions holding row locks.

## Red herrings
- A slow-query threshold that was just lowered makes logs noisier without anything getting
  slower. Check logging config changes before reading the volume as a regression.

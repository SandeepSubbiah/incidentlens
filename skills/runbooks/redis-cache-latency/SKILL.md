---
name: redis-cache-latency
kind: runbook
description: Redis latency spikes, cache stampedes and how cache dependencies leak into health checks and request paths.
tags: [redis, cache, latency, stampede, resharding, migration, health-indicator, timeout]
---
# Redis and cache latency

## Symptoms
- Spring Boot logs: `Health contributor ... (redis) took 1288ms to respond`.
- Cache misses with high Redis latency on request paths; elevated p99.

## Diagnose
1. Check maintenance: node migrations, resharding, failovers and version upgrades cause latency
   spikes.
2. Find every place Redis latency surfaces: request paths, health indicators, rate limiters,
   session stores.
3. A health indicator that includes Redis turns Redis latency into probe failures if the probe
   uses that endpoint.

## Common causes
- Maintenance or resharding during business hours.
- Hot keys or a stampede after a cache flush.

## Fix
- Exclude cache health from readiness; keep it in a separate health group for dashboards.
- Short client timeouts with fallback to the source of truth.
- Request coalescing or jittered TTLs to avoid stampedes.

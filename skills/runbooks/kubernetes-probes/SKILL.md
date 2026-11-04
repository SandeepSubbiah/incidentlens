---
name: kubernetes-probes
kind: runbook
description: Readiness, liveness and startup probe design; endpoints flapping and 503 no healthy upstream when probes depend on slow dependencies.
tags: [kubernetes, readiness, liveness, startup-probe, probe, 503, no-healthy-upstream, endpoints, actuator, health]
---
# Kubernetes probes

## Symptoms
- Intermittent `503 no healthy upstream` from the ingress, in bursts, with zero pod restarts.
- Events: `Readiness probe failed ... context deadline exceeded`.
- `kubectl get endpoints` shows pod IPs disappearing and coming back.

## Diagnose
1. Read the probe definitions: path, `timeoutSeconds`, `periodSeconds`, `failureThreshold`.
2. Check what the probe path checks. The aggregate `/actuator/health` includes every health
   indicator (database, Redis, disk); `/actuator/health/readiness` includes only the readiness
   group.
3. Compare the probe timeout with the latency of the slowest included dependency.
4. Correlate probe failures with dependency maintenance or latency spikes.

## Common causes
- Readiness probe pointed at the aggregate health endpoint, so a slow shared dependency marks
  every pod unready at once.
- `timeoutSeconds: 1` with `failureThreshold: 1`: a single slow check removes the pod.
- Liveness probes that check dependencies, causing restart storms.

## Fix
- Point readiness at `/actuator/health/readiness` and keep shared dependencies out of it.
- Use `failureThreshold` of 3 or more and a timeout above the endpoint's p99.
- Never put external dependencies in liveness.

## Red herrings
- Noisy, long-standing application errors that are hidden client-side do not remove endpoints.

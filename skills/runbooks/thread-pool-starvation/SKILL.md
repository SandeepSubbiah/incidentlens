---
name: thread-pool-starvation
kind: runbook
description: Request thread pool or event-loop starvation from blocking calls; queueing latency with low CPU.
tags: [threads, thread-pool, tomcat, webflux, netty, event-loop, blocking, starvation, latency]
---
# Thread pool starvation

## Symptoms
- Latency climbs while CPU stays low; thread dumps show most request threads `WAITING` or
  `TIMED_WAITING` on the same call.
- In WebFlux/Netty: `blocking call detected` warnings, or a handful of event-loop threads all
  stuck in I/O.

## Diagnose
1. Take thread dumps and group threads by top frame; one dominant frame is the bottleneck.
2. Compare `server.tomcat.threads.max` and executor sizes with concurrent load and with the
   latency of the dependency they wait on.
3. Check for blocking JDBC or HTTP calls on reactive threads.

## Fix
- Add timeouts so threads cannot wait indefinitely; bulkhead slow dependencies on their own
  executors.
- Move blocking work off event loops (`publishOn(Schedulers.boundedElastic())`).

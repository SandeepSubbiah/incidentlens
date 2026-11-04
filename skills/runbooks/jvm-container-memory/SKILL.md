---
name: jvm-container-memory
kind: runbook
description: JVM processes killed by the container memory limit (OOMKilled, exit 137) and how heap, non-heap and limits interact.
tags: [jvm, kubernetes, memory, oomkilled, exit-137, xmx, maxrampercentage, container-limit]
---
# JVM memory inside containers

## Symptoms
- Pods restart with Last State `OOMKilled`, exit code 137, often with no Java `OutOfMemoryError`
  in the application logs (the kernel kills the process; the JVM never gets to log).
- `kubectl top` shows pods close to the memory limit just before restarts.

## Diagnose
1. Compare the container memory limit with the JVM's maximum heap (`-Xmx`, or
   `-XX:MaxRAMPercentage` applied to the limit).
2. Add non-heap: metaspace, code cache, thread stacks (about 1 MB per thread), direct buffers,
   GC structures. Total JVM footprint is typically heap + 25-50%.
3. Check recent changes to limits, requests, `JAVA_OPTS` or base images.
4. A Java `OutOfMemoryError` means the heap filled; a silent OOMKill means the process exceeded
   the cgroup limit. They have different fixes.

## Common causes
- Limit lowered (cost right-sizing) while a hard-coded `-Xmx` stayed the same.
- `-Xmx` equal to or above the container limit.
- Thread count growth or large direct buffers (Netty, Kafka clients).

## Fix
- Size heap relative to the limit: `-XX:MaxRAMPercentage=70` to `75` instead of a fixed `-Xmx`,
  or raise the limit to heap + non-heap headroom.
- Right-size from p99 of the whole container, not p95 of heap.

## Red herrings
- Slow-query warnings or GC pause logs rarely cause OOMKills on their own.
- p95 memory over 30 days hides batch jobs and traffic peaks.

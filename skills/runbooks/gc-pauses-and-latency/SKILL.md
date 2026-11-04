---
name: gc-pauses-and-latency
kind: runbook
description: When garbage collection explains latency and when it is a red herring; reading G1 GC logs.
tags: [gc, garbage-collection, g1, pause, latency, heap, jvm]
---
# GC pauses and latency

## Diagnose
1. Read pause durations, not just frequency. G1 young pauses of 10-50 ms cannot explain
   multi-second latency.
2. GC explains latency only when pauses are long (hundreds of ms or more), frequent, or full
   GCs (`Pause Full`) appear, and they line up with the slow requests.
3. Heap occupancy after GC that keeps rising suggests a leak; stable post-GC occupancy does not.
4. Humongous allocations point at large objects (big batches, large responses).

## Common causes of real GC trouble
- Heap too small for the live set, causing back-to-back collections.
- Allocation spikes from batch jobs or unbounded result sets.

## Red herrings
- Routine young-generation pauses printed at INFO level during an unrelated incident.
- More GC activity during an incident is often a consequence of more queued work.

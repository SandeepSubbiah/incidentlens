---
name: dns-and-service-discovery
kind: runbook
description: DNS resolution failures, ndots search-path amplification and stale service discovery in Kubernetes.
tags: [dns, coredns, ndots, resolution, unknownhostexception, service-discovery, network]
---
# DNS and service discovery

## Symptoms
- `UnknownHostException`, `Temporary failure in name resolution`, or connection latency that
  is consistently about 5 seconds (resolver timeout).
- CoreDNS CPU spikes or dropped packets; conntrack table full on nodes.

## Diagnose
1. Check the pod's `ndots` setting: with the default of 5, names with fewer dots are tried
   against every search domain first, multiplying queries.
2. Check CoreDNS logs, replicas and resource limits.
3. JVM DNS caching (`networkaddress.cache.ttl`) can pin stale IPs after a service moves.

## Fix
- Use fully qualified names with a trailing dot for external hosts, or lower `ndots`.
- Scale CoreDNS or enable NodeLocal DNSCache.
- Set a finite JVM DNS TTL.

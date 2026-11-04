---
name: spring-transaction-boundaries
kind: runbook
description: Spring @Transactional pitfalls - remote calls in transactions, self-invocation, open-in-view and readOnly.
tags: [spring, transactional, transaction, jpa, hibernate, open-in-view, self-invocation, proxy]
---
# Spring transaction boundaries

## Symptoms
- Connection pool pressure that tracks the latency of a downstream service.
- Transactions that last seconds in traces even though queries take milliseconds.

## Diagnose
1. Find the `@Transactional` method on the failing path and list everything it calls.
2. Any HTTP, gRPC, messaging or sleep inside it keeps the database connection checked out.
3. Check `spring.jpa.open-in-view`: when enabled, a connection can stay bound to the whole web
   request, not just the transaction.
4. Remember that calling a `@Transactional` method from the same class bypasses the proxy, so
   the annotation has no effect there.

## Common causes
- A refactor that moved a remote call into a transactional method so that results are
  "persisted atomically".
- Wrapping a whole use case, including external calls, in one transaction.

## Fix
- Split the method: call the remote service first (or after commit), then run a short
  transaction for the database writes.
- For atomicity across a remote call, use an outbox or a state machine (PENDING, then
  APPROVED or REJECTED) instead of holding a transaction open.

## Red herrings
- The open-in-view startup warning is long-standing in most services; check whether it changed
  before blaming it.

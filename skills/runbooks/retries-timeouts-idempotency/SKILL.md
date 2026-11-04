---
name: retries-timeouts-idempotency
kind: runbook
description: Retries, client timeouts and idempotency - duplicate side effects when non-idempotent requests are retried after a timeout.
tags: [retry, resilience4j, timeout, idempotency, idempotency-key, duplicate, payments, post]
---
# Retries, timeouts and idempotency

## Symptoms
- Duplicate side effects: double charges, duplicate orders, repeated emails.
- Logs show retries after `SocketTimeoutException: Read timed out`, and the downstream system
  records more than one success for the same business key.
- No error-rate alert, because the retries eventually succeed.

## Diagnose
1. A client timeout does not mean the server failed. Check whether the server completed the
   first attempt (webhooks, server-side logs, reconciliation).
2. Check which operations the retry policy covers. Retrying a non-idempotent `POST` without an
   idempotency key creates a new side effect per attempt.
3. Compare the client read timeout with the dependency's current latency (status pages, p99).
4. Count attempts per business key to confirm the duplicates match the retry count.

## Common causes
- A retry annotation or policy applied to create or charge operations.
- Read timeout set below the dependency's normal p99, so slowdowns trigger retries.

## Fix
- Send an idempotency key (for example derived from the order id) on every create call, or
  remove retries from non-idempotent operations.
- Before retrying a create after a timeout, look the operation up by business key.
- Set timeouts from dependency latency budgets, and retry only on idempotent or keyed requests.

## Red herrings
- Reconciliation or ledger conflicts are a consequence of duplicates, not the cause.

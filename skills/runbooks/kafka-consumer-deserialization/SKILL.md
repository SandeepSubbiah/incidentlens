---
name: kafka-consumer-deserialization
kind: runbook
description: Kafka consumers failing on poison pills and schema changes; consumer lag, dead-letter topics and Jackson unknown properties.
tags: [kafka, consumer, lag, dlt, dead-letter, jackson, deserialization, schema, unrecognizedpropertyexception, objectmapper]
---
# Kafka consumer deserialization failures

## Symptoms
- Consumer group lag grows while consumer pods look healthy (normal CPU, no restarts).
- Errors such as `UnrecognizedPropertyException`, `MismatchedInputException` or
  `SerializationException`, followed by records published to a `.DLT` topic.
- Downstream side effects (reservations, emails, projections) silently stop.

## Diagnose
1. Find the first failing offset and its timestamp; compare with producer deploys.
2. Read the producer change: new, renamed or retyped fields in the event.
3. Check how the consumer deserialises: Spring's configured `ObjectMapper` ignores unknown
   properties by default, but `new ObjectMapper()` fails on them
   (`FAIL_ON_UNKNOWN_PROPERTIES` is true).
4. Count DLT records per partition to size the impact and plan a replay.

## Common causes
- Producer added a field; consumer uses a strict, hand-built mapper.
- No schema compatibility checks between producer and consumer.

## Fix
- Make consumers tolerant: `@JsonIgnoreProperties(ignoreUnknown = true)` on event types, or
  configure the mapper with `FAIL_ON_UNKNOWN_PROPERTIES` disabled (or inject Spring's mapper).
- Replay the dead-letter topic after the fix is deployed.
- Add a contract test that deserialises the producer's latest event sample.

## Red herrings
- Topic retention changes and unrelated batch-job slowness rarely stop a consumer outright.

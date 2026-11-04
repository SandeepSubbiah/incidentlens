---
name: change-correlation
kind: runbook
description: Method for correlating incidents with deploys, configuration changes and maintenance windows, and for ruling out coincidental changes.
tags: [deploy, change, rollback, correlation, timeline, maintenance, release, red-herring]
---
# Change correlation

## Method
1. Fix the time of the first symptom from the earliest error or metric breach, not from when
   the alert fired.
2. List every change in the window before it: application deploys, config and infrastructure
   changes, dependency maintenance, feature flags, traffic events.
3. For each change, write the mechanism by which it could cause the symptom. A change with no
   plausible mechanism is coincidence, however close in time.
4. Check direction: the cause must precede the effect, and the effect should scale with it.
5. Prefer the change whose mechanism explains every symptom, including the absence of
   expected ones (for example no Java exception during an OOMKill).

## Mitigation first
When customer impact is ongoing, roll back or disable the suspect change before proving the
root cause, if rollback is safe and quick.

## Red herrings
- Errors that existed before the incident at a similar rate.
- Dependency bumps or batch-size changes with no mechanism linking them to the symptom.
- Autoscaling events, which are usually a reaction to the incident.

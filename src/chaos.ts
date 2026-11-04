// Fault injection for demonstrating self-healing. Faults live in memory only and expire.

const outages = new Map<string, number>();

export function setOutage(model: string, seconds: number) {
  outages.set(model, Date.now() + seconds * 1000);
}

export function inOutage(model: string): boolean {
  const until = outages.get(model);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  outages.delete(model);
  return false;
}

export function activeFaults() {
  return [...outages.entries()].filter(([, until]) => until > Date.now()).map(([model, until]) => ({ kind: 'model-outage', model, until: new Date(until).toISOString() }));
}

export function clearFaults() {
  outages.clear();
}

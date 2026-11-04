/**
 * Standalone P1 continuity router prototype. NOT connected to live IncidentLens inference.
 * Makes no provider calls by itself and cannot change policies or deploy anything.
 */
export type DataClass = 'public' | 'internal' | 'confidential' | 'regulated';
export type FailureKind = 'unavailable' | 'timeout' | 'rate_limit' | 'invalid_response' | 'auth' | 'billing' | 'policy' | 'security' | 'unknown';
export class ProviderFailure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) { super(message); this.name = 'ProviderFailure'; this.kind = kind; }
}
export type ContinuityEvent = { requestId: string; endpointId: string; kind: 'try'|'success'|'failure'|'breaker_open'|'skipped'; attempt: number; reason?: FailureKind | 'unavailable_breaker' };
export interface RequestScope {
  requestId: string;
  tenantId: string;
  dataClass: DataClass;
  operation: string;
  neededCapabilities: string[];
  allowedEndpointIds: string[];
  allowedRegions: string[];
  primaryEndpointId: string;
  allowFallback: boolean;
  /** False after a tool with side effects or streamed output has been committed. */
  safeToRetry: boolean;
  outputCommitted: boolean;
  maxAttempts?: number;
}
export interface Endpoint<T> {
  id: string;
  region: string;
  enabled: boolean;
  priority: number;
  allowedTenants: string[];
  dataClasses: DataClass[];
  operations: string[];
  capabilities: string[];
  invoke: (request: RequestScope, signal?: AbortSignal) => Promise<T>;
}
export type Routed<T> = { value: T; endpointId: string; attempts: number; fallback: boolean };
type Breaker = { consecutiveFailures: number; openUntil: number };
const RETRYABLE: ReadonlySet<FailureKind> = new Set(['unavailable', 'timeout', 'rate_limit', 'invalid_response']);

export class ContinuityRouter<T> {
  private breakers = new Map<string, Breaker>();
  private readonly endpoints: Endpoint<T>[];
  private readonly event: (event: ContinuityEvent) => void;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  constructor(
    endpoints: Endpoint<T>[],
    event: (event: ContinuityEvent) => void = () => {},
    now: () => number = () => Date.now(),
    threshold = 2,
    cooldownMs = 30_000,
  ) {
    this.endpoints = endpoints; this.event = event; this.now = now; this.threshold = threshold; this.cooldownMs = cooldownMs;
    if (threshold < 1 || cooldownMs < 1) throw new Error('invalid breaker parameters');
    if (new Set(endpoints.map((e) => e.id)).size !== endpoints.length) throw new Error('duplicate endpoint id');
  }

  health(): Array<{ endpointId: string; state: 'closed'|'open'|'half_open'; consecutiveFailures: number }> {
    return this.endpoints.map((endpoint) => {
      const b = this.breakers.get(endpoint.id) ?? { consecutiveFailures: 0, openUntil: 0 };
      return { endpointId: endpoint.id, state: b.openUntil > this.now() ? 'open' : b.openUntil > 0 ? 'half_open' : 'closed', consecutiveFailures: b.consecutiveFailures };
    });
  }

  async execute(request: RequestScope, signal?: AbortSignal): Promise<Routed<T>> {
    if (!request.requestId || !request.tenantId || !request.primaryEndpointId || !request.operation) throw new Error('missing scope');
    if (request.outputCommitted && request.safeToRetry) throw new Error('cannot retry committed output');
    const allowed = (e: Endpoint<T>) => e.enabled && request.allowedEndpointIds.includes(e.id) &&
      request.allowedRegions.includes(e.region) && e.allowedTenants.includes(request.tenantId) &&
      e.dataClasses.includes(request.dataClass) && e.operations.includes(request.operation) &&
      request.neededCapabilities.every((c) => e.capabilities.includes(c));
    const primary = this.endpoints.find((e) => e.id === request.primaryEndpointId);
    if (!primary || !allowed(primary)) throw new ProviderFailure('policy', 'primary endpoint not permitted');
    const backups = request.allowFallback && request.safeToRetry && !request.outputCommitted
      ? this.endpoints.filter((e) => e.id !== primary.id && allowed(e)).sort((a,b) => a.priority - b.priority)
      : [];
    const candidates = [primary, ...backups];
    const maxAttempts = Math.min(candidates.length, Math.max(1, Math.min(3, request.maxAttempts ?? 2)));
    let last: unknown = new ProviderFailure('unavailable', 'no healthy approved endpoint');
    let attempted = 0;
    for (const endpoint of candidates) {
      if (attempted >= maxAttempts) break;
      if (signal?.aborted) throw new ProviderFailure('timeout', 'request aborted');
      const breaker = this.breakers.get(endpoint.id) ?? { consecutiveFailures: 0, openUntil: 0 };
      if (breaker.openUntil > this.now()) {
        this.event({ requestId: request.requestId, endpointId: endpoint.id, kind: 'skipped', attempt: attempted, reason: 'unavailable_breaker' });
        continue;
      }
      attempted++;
      this.event({ requestId: request.requestId, endpointId: endpoint.id, kind: 'try', attempt: attempted });
      try {
        const value = await endpoint.invoke(request, signal);
        this.breakers.set(endpoint.id, { consecutiveFailures: 0, openUntil: 0 });
        this.event({ requestId: request.requestId, endpointId: endpoint.id, kind: 'success', attempt: attempted });
        return { value, endpointId: endpoint.id, attempts: attempted, fallback: endpoint.id !== primary.id };
      } catch (error) {
        const kind: FailureKind = error instanceof ProviderFailure ? error.kind : 'unknown';
        last = error;
        this.event({ requestId: request.requestId, endpointId: endpoint.id, kind: 'failure', attempt: attempted, reason: kind });
        if (RETRYABLE.has(kind)) {
          const failures = breaker.consecutiveFailures + 1;
          const openUntil = failures >= this.threshold ? this.now() + this.cooldownMs : 0;
          this.breakers.set(endpoint.id, { consecutiveFailures: failures, openUntil });
          if (openUntil) this.event({ requestId: request.requestId, endpointId: endpoint.id, kind: 'breaker_open', attempt: attempted, reason: kind });
        }
        // A security/policy/auth/billing violation or unknown error is never routed elsewhere.
        if (!RETRYABLE.has(kind) || !request.safeToRetry || request.outputCommitted) break;
      }
    }
    throw last;
  }
}

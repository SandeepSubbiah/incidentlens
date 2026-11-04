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
/** Trusted, server-side routing policy. When supplied, client-claimed scope can only narrow it, never widen it. */
export interface ServerRoutingPolicy {
  tenantId: string;
  allowedEndpointIds: readonly string[];
  allowedRegions: readonly string[];
  dataClasses: readonly DataClass[];
  operations: readonly string[];
  allowFallback: boolean;
  maxAttempts: number;
}
export interface ContinuityRouterOptions {
  /** Per-attempt deadline. An endpoint that ignores the AbortSignal is still cut off by race. Default 30000. */
  perAttemptTimeoutMs?: number;
  /** End-to-end deadline across all attempts. Default 60000. */
  overallTimeoutMs?: number;
  /** Consecutive half-open probe successes required to close the breaker. Default 1. */
  halfOpenSuccessThreshold?: number;
  /** Trusted server-derived policy; intersected with (never widened by) the request scope. */
  serverPolicy?: ServerRoutingPolicy;
  /** Secondary sink for telemetry failures. Also isolated: if it throws, routing is unaffected. */
  onTelemetryError?: (error: unknown, event: ContinuityEvent) => void;
}
type Breaker = { consecutiveFailures: number; openUntil: number; probeInFlight: boolean; probeSuccesses: number };
const RETRYABLE: ReadonlySet<FailureKind> = new Set(['unavailable', 'timeout', 'rate_limit', 'invalid_response']);
const DATA_CLASSES: ReadonlySet<string> = new Set(['public', 'internal', 'confidential', 'regulated']);
const newBreaker = (): Breaker => ({ consecutiveFailures: 0, openUntil: 0, probeInFlight: false, probeSuccesses: 0 });

function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => !isNonEmptyString(v))) throw new Error(`invalid ${field}: expected an array of non-empty strings`);
  return [...new Set(value as string[])];
}
function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid ${field}: expected a boolean`);
  return value;
}
function positiveMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`invalid ${field}: expected a positive finite number`);
  return value;
}

/** Validates untrusted runtime input and returns a deep-frozen snapshot; later caller/endpoint mutation cannot widen routing. */
function snapshotRequest(request: RequestScope): RequestScope {
  if (!request || typeof request !== 'object') throw new Error('invalid request: expected an object');
  const r = request as Record<string, unknown>;
  for (const field of ['requestId', 'tenantId', 'primaryEndpointId', 'operation']) {
    if (!isNonEmptyString(r[field])) throw new Error(`invalid ${field}: expected a non-empty string`);
  }
  if (!DATA_CLASSES.has(r.dataClass as string)) throw new Error('invalid dataClass: expected public, internal, confidential or regulated');
  let maxAttempts: number | undefined;
  if (r.maxAttempts !== undefined) {
    if (typeof r.maxAttempts !== 'number' || !Number.isInteger(r.maxAttempts) || r.maxAttempts < 1) throw new Error('invalid maxAttempts: expected a finite integer >= 1');
    maxAttempts = r.maxAttempts;
  }
  const snapshot: RequestScope = {
    requestId: r.requestId as string,
    tenantId: r.tenantId as string,
    dataClass: r.dataClass as DataClass,
    operation: r.operation as string,
    neededCapabilities: Object.freeze(stringArray(r.neededCapabilities, 'neededCapabilities')) as unknown as string[],
    allowedEndpointIds: Object.freeze(stringArray(r.allowedEndpointIds, 'allowedEndpointIds')) as unknown as string[],
    allowedRegions: Object.freeze(stringArray(r.allowedRegions, 'allowedRegions')) as unknown as string[],
    primaryEndpointId: r.primaryEndpointId as string,
    allowFallback: booleanField(r.allowFallback, 'allowFallback'),
    safeToRetry: booleanField(r.safeToRetry, 'safeToRetry'),
    outputCommitted: booleanField(r.outputCommitted, 'outputCommitted'),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
  return Object.freeze(snapshot);
}

function snapshotPolicy(policy: ServerRoutingPolicy): ServerRoutingPolicy {
  if (!policy || typeof policy !== 'object') throw new Error('invalid serverPolicy: expected an object');
  if (!isNonEmptyString(policy.tenantId)) throw new Error('invalid serverPolicy.tenantId: expected a non-empty string');
  const dataClasses = stringArray(policy.dataClasses, 'serverPolicy.dataClasses');
  if (dataClasses.some((d) => !DATA_CLASSES.has(d))) throw new Error('invalid serverPolicy.dataClasses: unknown data class');
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw new Error('invalid serverPolicy.maxAttempts: expected a finite integer >= 1');
  return Object.freeze({
    tenantId: policy.tenantId,
    allowedEndpointIds: Object.freeze(stringArray(policy.allowedEndpointIds, 'serverPolicy.allowedEndpointIds')),
    allowedRegions: Object.freeze(stringArray(policy.allowedRegions, 'serverPolicy.allowedRegions')),
    dataClasses: Object.freeze(dataClasses) as unknown as readonly DataClass[],
    operations: Object.freeze(stringArray(policy.operations, 'serverPolicy.operations')),
    allowFallback: booleanField(policy.allowFallback, 'serverPolicy.allowFallback'),
    maxAttempts: policy.maxAttempts,
  });
}

export class ContinuityRouter<T> {
  private breakers = new Map<string, Breaker>();
  private readonly endpoints: Endpoint<T>[];
  private readonly event: (event: ContinuityEvent) => void;
  private readonly now: () => number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly perAttemptTimeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly serverPolicy: ServerRoutingPolicy | null;
  private readonly onTelemetryError: ((error: unknown, event: ContinuityEvent) => void) | null;
  private telemetryFailureTotal = 0;
  constructor(
    endpoints: Endpoint<T>[],
    event: (event: ContinuityEvent) => void = () => {},
    now: () => number = () => Date.now(),
    threshold = 2,
    cooldownMs = 30_000,
    options: ContinuityRouterOptions = {},
  ) {
    if (!Number.isInteger(threshold) || threshold < 1 || !Number.isFinite(cooldownMs) || cooldownMs < 1) throw new Error('invalid breaker parameters');
    if (!Array.isArray(endpoints)) throw new Error('invalid endpoints: expected an array');
    if (new Set(endpoints.map((e) => e?.id)).size !== endpoints.length) throw new Error('duplicate endpoint id');
    this.endpoints = endpoints.map((e) => {
      if (!e || !isNonEmptyString(e.id) || !isNonEmptyString(e.region) || typeof e.enabled !== 'boolean' || !Number.isFinite(e.priority) || typeof e.invoke !== 'function') throw new Error(`invalid endpoint definition: ${String(e?.id)}`);
      return Object.freeze({ ...e, allowedTenants: Object.freeze(stringArray(e.allowedTenants, 'endpoint.allowedTenants')), dataClasses: Object.freeze(stringArray(e.dataClasses, 'endpoint.dataClasses')) as unknown as DataClass[], operations: Object.freeze(stringArray(e.operations, 'endpoint.operations')), capabilities: Object.freeze(stringArray(e.capabilities, 'endpoint.capabilities')) }) as Endpoint<T>;
    });
    this.event = event; this.now = now; this.threshold = threshold; this.cooldownMs = cooldownMs;
    this.perAttemptTimeoutMs = options.perAttemptTimeoutMs === undefined ? 30_000 : positiveMs(options.perAttemptTimeoutMs, 'perAttemptTimeoutMs');
    this.overallTimeoutMs = options.overallTimeoutMs === undefined ? 60_000 : positiveMs(options.overallTimeoutMs, 'overallTimeoutMs');
    if (options.halfOpenSuccessThreshold !== undefined && (!Number.isInteger(options.halfOpenSuccessThreshold) || options.halfOpenSuccessThreshold < 1)) throw new Error('invalid halfOpenSuccessThreshold: expected an integer >= 1');
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 1;
    this.serverPolicy = options.serverPolicy === undefined ? null : snapshotPolicy(options.serverPolicy);
    this.onTelemetryError = options.onTelemetryError ?? null;
  }

  /** Number of telemetry callback failures isolated so far. A non-zero value means "could not report", distinct from "nothing to report". */
  get telemetryFailureCount(): number { return this.telemetryFailureTotal; }

  /** Telemetry is isolated: a throwing sink never changes a provider result, fallback decision or breaker outcome. */
  private emit(event: ContinuityEvent): void {
    try { this.event(event); } catch (error) {
      this.telemetryFailureTotal++;
      try { this.onTelemetryError?.(error, event); } catch { /* secondary sink is isolated too */ }
    }
  }

  health(): Array<{ endpointId: string; state: 'closed'|'open'|'half_open'; consecutiveFailures: number }> {
    return this.endpoints.map((endpoint) => {
      const b = this.breakers.get(endpoint.id) ?? newBreaker();
      return { endpointId: endpoint.id, state: b.openUntil > this.now() ? 'open' : b.openUntil > 0 ? 'half_open' : 'closed', consecutiveFailures: b.consecutiveFailures };
    });
  }

  private applyServerPolicy(snapshot: RequestScope): RequestScope {
    const policy = this.serverPolicy;
    if (!policy) return snapshot;
    if (snapshot.tenantId !== policy.tenantId) throw new ProviderFailure('policy', 'server policy: tenant mismatch');
    if (!policy.dataClasses.includes(snapshot.dataClass)) throw new ProviderFailure('policy', 'server policy: data class not permitted');
    if (!policy.operations.includes(snapshot.operation)) throw new ProviderFailure('policy', 'server policy: operation not permitted');
    const effective: RequestScope = {
      ...snapshot,
      allowedEndpointIds: Object.freeze(snapshot.allowedEndpointIds.filter((id) => policy.allowedEndpointIds.includes(id))) as unknown as string[],
      allowedRegions: Object.freeze(snapshot.allowedRegions.filter((r) => policy.allowedRegions.includes(r))) as unknown as string[],
      allowFallback: snapshot.allowFallback && policy.allowFallback,
      maxAttempts: Math.min(snapshot.maxAttempts ?? policy.maxAttempts, policy.maxAttempts),
    };
    return Object.freeze(effective);
  }

  /**
   * Races invoke() against per-attempt / overall / caller aborts. Guarantees timer and listener
   * cleanup. A non-cooperative endpoint promise cannot be killed in JS: its late settlement is
   * ignored by the router, but only the endpoint itself can guarantee it performed no late effect.
   */
  private async invokeWithDeadline(endpoint: Endpoint<T>, request: RequestScope, callerSignal: AbortSignal | undefined, overallSignal: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let abortReason: 'timeout' | 'aborted' = 'aborted';
    const removers: Array<() => void> = [];
    const listen = (signal: AbortSignal | undefined, reason: 'timeout' | 'aborted') => {
      if (!signal) return;
      const onAbort = () => { abortReason = reason; controller.abort(); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      removers.push(() => signal.removeEventListener('abort', onAbort));
    };
    listen(callerSignal, 'aborted');
    listen(overallSignal, 'timeout');
    const timer = setTimeout(() => { abortReason = 'timeout'; controller.abort(); }, this.perAttemptTimeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new ProviderFailure('timeout', abortReason === 'timeout' ? 'provider attempt timeout' : 'request aborted'));
      if (controller.signal.aborted) { onAbort(); return; }
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removers.push(() => controller.signal.removeEventListener('abort', onAbort));
    });
    try {
      const invocation = Promise.resolve().then(() => endpoint.invoke(request, controller.signal));
      invocation.catch(() => { /* late rejection after a timeout is observed here, never unhandled */ });
      return await Promise.race([invocation, aborted]);
    } catch (error) {
      if (error instanceof ProviderFailure && error.kind === 'timeout') throw error;
      if (controller.signal.aborted) throw new ProviderFailure('timeout', abortReason === 'timeout' ? 'provider attempt timeout' : 'request aborted');
      throw error;
    } finally {
      clearTimeout(timer);
      for (const remove of removers) remove();
    }
  }

  async execute(request: RequestScope, signal?: AbortSignal): Promise<Routed<T>> {
    const snapshot = this.applyServerPolicy(snapshotRequest(request));
    // An already-committed operation must never be invoked again, whatever retry flag accompanies it.
    // Resuming it requires a separately authorized new operation, not a replay of this one.
    if (snapshot.outputCommitted) throw new Error('cannot retry committed output');
    const allowed = (e: Endpoint<T>) => e.enabled && snapshot.allowedEndpointIds.includes(e.id) &&
      snapshot.allowedRegions.includes(e.region) && e.allowedTenants.includes(snapshot.tenantId) &&
      e.dataClasses.includes(snapshot.dataClass) && e.operations.includes(snapshot.operation) &&
      snapshot.neededCapabilities.every((c) => e.capabilities.includes(c));
    const primary = this.endpoints.find((e) => e.id === snapshot.primaryEndpointId);
    if (!primary || !allowed(primary)) throw new ProviderFailure('policy', 'primary endpoint not permitted');
    const backups = snapshot.allowFallback && snapshot.safeToRetry && !snapshot.outputCommitted
      ? this.endpoints.filter((e) => e.id !== primary.id && allowed(e)).sort((a, b) => a.priority - b.priority)
      : [];
    const candidates = [primary, ...backups];
    const maxAttempts = Math.min(candidates.length, Math.max(1, Math.min(3, snapshot.maxAttempts ?? 2)));
    let last: unknown = new ProviderFailure('unavailable', 'no healthy approved endpoint');
    let attempted = 0;
    const overallController = new AbortController();
    const overallTimer = setTimeout(() => overallController.abort(), this.overallTimeoutMs);
    try {
      for (const endpoint of candidates) {
        if (attempted >= maxAttempts) break;
        if (signal?.aborted || overallController.signal.aborted) throw new ProviderFailure('timeout', signal?.aborted ? 'request aborted' : 'request deadline exceeded');
        const breaker = this.breakers.get(endpoint.id) ?? newBreaker();
        this.breakers.set(endpoint.id, breaker);
        if (breaker.openUntil > this.now()) {
          this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'skipped', attempt: attempted, reason: 'unavailable_breaker' });
          continue;
        }
        // Half-open: exactly one probe lease, acquired synchronously before any await.
        const isProbe = breaker.openUntil > 0;
        if (isProbe && breaker.probeInFlight) {
          this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'skipped', attempt: attempted, reason: 'unavailable_breaker' });
          continue;
        }
        if (isProbe) breaker.probeInFlight = true;
        attempted++;
        this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'try', attempt: attempted });
        try {
          const value = await this.invokeWithDeadline(endpoint, snapshot, signal, overallController.signal);
          const current = this.breakers.get(endpoint.id) ?? breaker;
          if (isProbe) {
            const successes = current.probeSuccesses + 1;
            if (successes >= this.halfOpenSuccessThreshold) this.breakers.set(endpoint.id, newBreaker());
            else this.breakers.set(endpoint.id, { consecutiveFailures: current.consecutiveFailures, openUntil: current.openUntil, probeInFlight: false, probeSuccesses: successes });
          } else {
            this.breakers.set(endpoint.id, newBreaker());
          }
          this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'success', attempt: attempted });
          return { value, endpointId: endpoint.id, attempts: attempted, fallback: endpoint.id !== primary.id };
        } catch (error) {
          const kind: FailureKind = error instanceof ProviderFailure ? error.kind : 'unknown';
          last = error;
          const current = this.breakers.get(endpoint.id) ?? breaker;
          const callerAborted = Boolean(signal?.aborted);
          if (isProbe) {
            if (!callerAborted && RETRYABLE.has(kind)) {
              const failures = current.consecutiveFailures + 1;
              this.breakers.set(endpoint.id, { consecutiveFailures: failures, openUntil: this.now() + this.cooldownMs, probeInFlight: false, probeSuccesses: 0 });
              this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'failure', attempt: attempted, reason: kind });
              this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'breaker_open', attempt: attempted, reason: kind });
            } else {
              this.breakers.set(endpoint.id, { ...current, probeInFlight: false });
              this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'failure', attempt: attempted, reason: kind });
            }
          } else {
            this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'failure', attempt: attempted, reason: kind });
            if (!callerAborted && RETRYABLE.has(kind)) {
              const failures = current.consecutiveFailures + 1;
              const openUntil = failures >= this.threshold ? this.now() + this.cooldownMs : 0;
              this.breakers.set(endpoint.id, { consecutiveFailures: failures, openUntil, probeInFlight: false, probeSuccesses: 0 });
              if (openUntil) this.emit({ requestId: snapshot.requestId, endpointId: endpoint.id, kind: 'breaker_open', attempt: attempted, reason: kind });
            }
          }
          if (callerAborted || overallController.signal.aborted) throw error;
          // A security/policy/auth/billing violation or unknown error is never routed elsewhere.
          if (!RETRYABLE.has(kind) || !snapshot.safeToRetry || snapshot.outputCommitted) break;
        }
      }
    } finally {
      clearTimeout(overallTimer);
    }
    throw last;
  }
}

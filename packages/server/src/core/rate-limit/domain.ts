export type RateOptions = {
  enabled: boolean;
  windowSecs: number;
  capacity: number;
  registration: number;
  registrationFallback: number;
  authentication: number;
  authenticationFallback: number;
  resource: number;
  resourceFallback: number;
};
export const defaultRateOptions: RateOptions = {
  enabled: true,
  windowSecs: 60,
  capacity: 4096,
  registration: 20,
  registrationFallback: 5,
  authentication: 60,
  authenticationFallback: 20,
  resource: 600,
  resourceFallback: 120,
};
type Policy = 'registration' | 'authentication' | 'resource';
type Bucket = { window: number; count: number };
export class LocalLimiter {
  private entries = new Map<string, Bucket>();
  private overflow = new Map<Policy, Bucket>();
  private totals = {
    registration: { allowed: 0, denied: 0, overflow: 0 },
    authentication: { allowed: 0, denied: 0, overflow: 0 },
    resource: { allowed: 0, denied: 0, overflow: 0 },
  };
  private lastWindow = -1;
  options: RateOptions;
  now: () => number;
  constructor(options: RateOptions, now: () => number) {
    this.options = options;
    this.now = now;
  }
  consume(method: string, path: string, peer: string) {
    if (
      !this.options.enabled ||
      path === '/health/live' ||
      path === '/health/ready'
    )
      return undefined;
    const policy: Policy =
      method === 'POST' && path === '/api/v1/auth/register'
        ? 'registration'
        : method === 'POST' &&
            ['/api/v1/auth/login', '/api/v1/auth/session'].includes(path)
          ? 'authentication'
          : 'resource';
    const millis = this.now(),
      width = this.options.windowSecs * 1000,
      window = Math.floor(millis / width);
    if (window !== this.lastWindow) {
      for (const [key, bucket] of this.entries)
        if (bucket.window !== window) this.entries.delete(key);
      this.lastWindow = window;
    }
    const key = `${policy}:${peer}`;
    let bucket = this.entries.get(key);
    let overflow = false;
    if (!bucket) {
      if (this.entries.size >= this.options.capacity) {
        overflow = true;
        bucket = this.overflow.get(policy);
        if (!bucket || bucket.window !== window) {
          bucket = { window, count: 0 };
          this.overflow.set(policy, bucket);
        }
      } else {
        bucket = { window, count: 0 };
        this.entries.set(key, bucket);
      }
    }
    bucket.count++;
    const limit = overflow
      ? this.options[`${policy}Fallback`]
      : this.options[policy];
    const totals = this.totals[policy];
    if (overflow) totals.overflow++;
    if (bucket.count <= limit) {
      totals.allowed++;
      return undefined;
    }
    totals.denied++;
    return Math.max(1, Math.ceil((width - (millis % width)) / 1000));
  }
  metrics() {
    return this.options.enabled
      ? {
          enabled: true,
          redis_configured: false,
          window_secs: this.options.windowSecs,
          local_entries: this.entries.size,
          local_capacity: this.options.capacity,
          policies: (
            ['registration', 'authentication', 'resource'] as Policy[]
          ).map((policy) => ({
            policy,
            limit: this.options[policy],
            fallback_limit: this.options[`${policy}Fallback`],
            redis_allowed: 0,
            redis_denied: 0,
            local_allowed: this.totals[policy].allowed,
            local_denied: this.totals[policy].denied,
            fallbacks: this.totals[policy].overflow,
          })),
        }
      : {
          enabled: false,
          redis_configured: false,
          window_secs: 0,
          local_entries: 0,
          local_capacity: 0,
          policies: [],
        };
  }
}

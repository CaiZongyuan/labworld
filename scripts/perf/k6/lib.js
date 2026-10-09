import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import crypto from 'k6/crypto';

// Shared plumbing for the load scenarios. Everything here talks to the
// public HTTP interfaces only, exactly like a browser would: origin header,
// session cookie, x-csrf-token, idempotency-key on writes.
//
// Throttles are not failures: a 429 with the rate_limit.exceeded code is
// the documented backpressure contract, so it lands in its own counter and
// the report presents "expected throttles" separately from real business
// errors. Cross-machine latency (and therefore P95/P99 and RPS) is trend
// material, never a gate — spec §17.

export const BASE_URL = __ENV.PERF_BASE_URL;
export const ORIGIN = __ENV.PERF_ORIGIN ?? 'http://127.0.0.1:5173';
// The trajectory registers its own users and runs without a fixtures file,
// so the seeded-user list is optional at init time.
export const USERS = __ENV.PERF_USERS_FILE
  ? JSON.parse(open(__ENV.PERF_USERS_FILE))
  : [];

export const throttles = new Counter('expected_throttles');
export const businessErrors = new Counter('business_errors');
// k6's handleSummary only carries aggregates for custom counters (per-tag
// breakdowns never reach it), so the status split gets its own counters:
// a 4xx wave reads as a regression, a 5xx wave as capacity degradation.
export const businessErrors4xx = new Counter('business_error_4xx');
export const businessErrors5xx = new Counter('business_error_5xx');

// One session per VU, established at the first iteration and reused after
// — module scope in k6 is per VU, so this is the login-once pattern.
let session = null;

// Both the login and the register responses carry the session cookie and
// the CSRF token; everything a scenario needs to call authenticated
// endpoints is this shape.
export function sessionFrom(response, docs) {
  const cookie = response.cookies.labos_threejs_session?.[0];
  return {
    cookie: `${cookie.name}=${cookie.value}`,
    csrf: response.json('csrf_token'),
    docs,
  };
}

export function loginAs(index) {
  if (session) return session;
  const user = USERS[index % USERS.length];
  const response = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: { origin: ORIGIN, 'content-type': 'application/json' } },
  );
  check(response, { 'login 200': (r) => r.status === 200 });
  classify(response);
  if (response.status !== 200) return null;
  session = sessionFrom(response, user.docIds);
  return session;
}

// k6 has no uuid module; an idempotency key only needs uniqueness, which
// time plus random bytes provides.
export function idempotencyKey() {
  return `${Date.now()}-${crypto.hexEncode(crypto.randomBytes(8))}`;
}

export function headers(s, write) {
  return {
    origin: ORIGIN,
    'content-type': 'application/json',
    cookie: s.cookie,
    'x-csrf-token': s.csrf,
    ...(write ? { 'idempotency-key': idempotencyKey() } : {}),
  };
}

export function classify(response) {
  // The 429 body nests its code: {"error":{"code":"rate_limit.exceeded"}}.
  if (
    response.status === 429 &&
    response.json('error.code') === 'rate_limit.exceeded'
  ) {
    throttles.add(1);
  } else if (response.status >= 500) {
    businessErrors.add(1);
    businessErrors5xx.add(1);
  } else if (response.status >= 400) {
    businessErrors.add(1);
    businessErrors4xx.add(1);
  }
}

// A checked request that classifies its outcome; `ok` is the status the
// caller expects for the happy path. Returns the response or null.
export function call(name, ok, request) {
  const response = request();
  const passed = check(response, { [`${name} ${ok}`]: (r) => r.status === ok });
  classify(response);
  return passed ? response : null;
}

export function listDocuments(s) {
  return call('list', 200, () =>
    http.get(`${BASE_URL}/api/v1/knowledge/documents?limit=51`, {
      headers: headers(s),
    }),
  );
}

export function getDocument(s, id) {
  return call('get', 200, () =>
    http.get(`${BASE_URL}/api/v1/knowledge/documents/${id}`, {
      headers: headers(s),
    }),
  );
}

export function createDocument(s, title, markdown) {
  return call('create', 201, () =>
    http.post(
      `${BASE_URL}/api/v1/knowledge/documents`,
      JSON.stringify({ title, markdown }),
      {
        headers: headers(s, true),
      },
    ),
  );
}

export function scenarioOptions({
  vus = 2,
  duration = '60s',
  rail = true,
} = {}) {
  return {
    vus: Number(__ENV.PERF_VUS ?? vus),
    duration: __ENV.PERF_DURATION ?? duration,
    summaryTrendStats: ['avg', 'med', 'p(50)', 'p(95)', 'p(99)', 'max'],
    ...(rail
      ? {
          thresholds: {
            // Sanity rails only, not capacity claims: a run that drowns in
            // real errors is not a reading, it is a failure the command
            // should report.
            business_errors: ['count<100'],
          },
        }
      : {}),
  };
}

export function writeSummary(extra) {
  return (data) => {
    const metrics = {};
    for (const [name, metric] of Object.entries(data.metrics)) {
      const values = metric.values ?? metric.value ?? {};
      metrics[name] =
        metric.type === 'trend'
          ? {
              avg: values.avg,
              p50: values['p(50)'],
              p95: values['p(95)'],
              p99: values['p(99)'],
              max: values.max,
            }
          : values;
    }
    // Registered counters with zero adds do not appear in the summary; keep
    // them present so "no throttles" is explicit data, not a missing field.
    metrics.expected_throttles ??= { count: 0, rate: 0 };
    metrics.business_errors ??= { count: 0, rate: 0 };
    metrics.business_error_4xx ??= { count: 0, rate: 0 };
    metrics.business_error_5xx ??= { count: 0, rate: 0 };
    return {
      [__ENV.PERF_SUMMARY]: JSON.stringify(
        {
          scenario: __ENV.PERF_SCENARIO,
          vus: Number(__ENV.PERF_VUS ?? 0),
          duration: __ENV.PERF_DURATION,
          ...extra,
          metrics,
        },
        null,
        2,
      ),
    };
  };
}

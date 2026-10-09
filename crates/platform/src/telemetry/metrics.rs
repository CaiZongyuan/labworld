use opentelemetry::{
    KeyValue, global,
    metrics::{Counter, Histogram},
};
use std::{sync::OnceLock, time::Duration};
// Durations are recorded in seconds; the SDK defaults assume much coarser values.
const LATENCY_SECONDS: &[f64] = &[
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0,
];
struct Instruments {
    requests: Counter<u64>,
    request_duration: Histogram<f64>,
    jobs: Counter<u64>,
    job_duration: Histogram<f64>,
    storage: Histogram<f64>,
}
fn instruments() -> &'static Instruments {
    static METRICS: OnceLock<Instruments> = OnceLock::new();
    METRICS.get_or_init(|| {
        let meter = global::meter("labos_threejs");
        Instruments {
            requests: meter.u64_counter("labos_threejs.http.requests").build(),
            request_duration: meter
                .f64_histogram("labos_threejs.http.duration")
                .with_unit("s")
                .with_boundaries(LATENCY_SECONDS.to_vec())
                .build(),
            jobs: meter.u64_counter("labos_threejs.jobs.attempts").build(),
            job_duration: meter
                .f64_histogram("labos_threejs.jobs.duration")
                .with_unit("s")
                .with_boundaries(LATENCY_SECONDS.to_vec())
                .build(),
            storage: meter
                .f64_histogram("labos_threejs.storage.duration")
                .with_unit("s")
                .with_boundaries(LATENCY_SECONDS.to_vec())
                .build(),
        }
    })
}
pub fn method_name(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "HEAD" => "HEAD",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}
/// route comes only from Axum MatchedPath, never the raw URI or a query string.
pub fn http_completed(method: &'static str, route: String, status: u16, elapsed: Duration) {
    let class = match status / 100 {
        1 => "1xx",
        2 => "2xx",
        3 => "3xx",
        4 => "4xx",
        5 => "5xx",
        _ => "other",
    };
    let labels = [
        KeyValue::new("method", method),
        KeyValue::new("route", route),
        KeyValue::new("status", class),
    ];
    instruments().requests.add(1, &labels);
    instruments()
        .request_duration
        .record(elapsed.as_secs_f64(), &labels);
}
/// kind is from the process's registered Handler, not a free-form request field.
pub fn job_completed(kind: &'static str, outcome: &'static str, elapsed: Duration) {
    let labels = [
        KeyValue::new("kind", kind),
        KeyValue::new("outcome", outcome),
    ];
    instruments().jobs.add(1, &labels);
    instruments()
        .job_duration
        .record(elapsed.as_secs_f64(), &labels);
}
pub(super) fn storage_completed(operation: &'static str, outcome: &'static str, elapsed: Duration) {
    instruments().storage.record(
        elapsed.as_secs_f64(),
        &[
            KeyValue::new("operation", operation),
            KeyValue::new("outcome", outcome),
        ],
    );
}

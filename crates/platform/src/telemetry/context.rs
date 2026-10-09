use opentelemetry::{propagation::TextMapPropagator, trace::TraceContextExt};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;

pub fn trace_id(span: &Span) -> Option<String> {
    let context = span.context();
    let current = context.span();
    let sc = current.span_context();
    sc.is_valid().then(|| sc.trace_id().to_string())
}
pub fn http_span(request_id: &str, method: &str, route: &str, parent: Option<&str>) -> Span {
    let span = tracing::info_span!(
        "http.request",
        otel.kind = "server",
        request_id,
        method,
        route,
        trace_id = tracing::field::Empty,
        actor_id = tracing::field::Empty
    );
    if let Some(parent) = parent.filter(|value| value.len() == 55) {
        let carrier =
            std::collections::HashMap::from([("traceparent".to_owned(), parent.to_owned())]);
        let context = TraceContextPropagator::new().extract(&carrier);
        let _ = span.set_parent(context);
    }
    if let Some(id) = trace_id(&span) {
        span.record("trace_id", id);
    }
    span
}

#[derive(Clone, Default)]
pub struct Correlation {
    pub request_id: Option<String>,
    pub actor_id: Option<String>,
    pub job_id: Option<String>,
}
tokio::task_local! {static CORRELATION:std::cell::RefCell<Correlation>;}
pub async fn scope<T>(value: Correlation, task: impl std::future::Future<Output = T>) -> T {
    CORRELATION
        .scope(std::cell::RefCell::new(value), task)
        .await
}
pub fn correlation() -> Correlation {
    CORRELATION
        .try_with(|c| c.borrow().clone())
        .unwrap_or_default()
}
/// Call only after successful authentication; incoming headers never supply the actor.
pub fn record_actor(actor: &str) {
    if actor.len() > 64 {
        return;
    }
    let _ = CORRELATION.try_with(|c| c.borrow_mut().actor_id = Some(actor.to_owned()));
    Span::current().record("actor_id", actor);
}
pub fn current_traceparent() -> Option<String> {
    let mut carrier = std::collections::HashMap::new();
    TraceContextPropagator::new().inject_context(&Span::current().context(), &mut carrier);
    carrier.remove("traceparent")
}
pub struct JobContext<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub attempt: i32,
    pub request: Option<&'a str>,
    pub actor: Option<&'a str>,
    pub correlation: &'a str,
    pub causation: Option<&'a str>,
    pub parent: Option<&'a str>,
}
pub fn job_span(job: JobContext<'_>) -> Span {
    let span = tracing::info_span!(
        "job.attempt",
        otel.kind = "consumer",
        job_id = job.id,
        kind = job.kind,
        attempt = job.attempt,
        request_id = job.request,
        actor_id = job.actor,
        correlation_id = job.correlation,
        causation_id = job.causation,
        trace_id = tracing::field::Empty
    );
    let mut carrier = std::collections::HashMap::new();
    if let Some(parent) = job.parent.filter(|p| p.len() == 55) {
        carrier.insert("traceparent".to_owned(), parent.to_owned());
    }
    let _ = span.set_parent(TraceContextPropagator::new().extract(&carrier));
    if let Some(id) = trace_id(&span) {
        span.record("trace_id", id);
    }
    span
}

//! Optional, lossy telemetry. Business state never depends on a Collector response.
mod metrics;
mod settings;
mod storage;
pub use metrics::{http_completed, job_completed, method_name};
pub use settings::{FIELDS, TelemetrySettings};
pub(crate) use storage::observe as observe_storage;
mod context;
use crate::config::ConfigError;
pub use context::{
    Correlation, JobContext, correlation, current_traceparent, http_span, job_span, record_actor,
    scope, trace_id,
};
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_otlp::{RetryPolicy, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    Resource,
    metrics::{PeriodicReader, SdkMeterProvider, Stream},
    trace::{BatchConfigBuilder, BatchSpanProcessor, Sampler, SdkTracerProvider},
};
use std::time::Duration;
use tracing_subscriber::{EnvFilter, prelude::*};

pub struct TelemetryGuard {
    traces: Option<SdkTracerProvider>,
    metrics: Option<SdkMeterProvider>,
    _logs: tracing_appender::non_blocking::WorkerGuard,
}
impl TelemetryGuard {
    /// Call after business drain on a blocking thread. The metrics reader has a
    /// fixed five-second shutdown wait in SDK 0.33; it ignores a supplied timeout.
    pub fn shutdown(self) {
        if let Some(traces) = &self.traces {
            let _ = traces.shutdown_with_timeout(Duration::from_secs(2));
        }
        if let Some(metrics) = &self.metrics {
            let _ = metrics.shutdown();
        }
    }
}
pub async fn init(filter: EnvFilter, service: &'static str) -> Result<TelemetryGuard, ConfigError> {
    let settings = TelemetrySettings::from_env()?;
    tokio::task::spawn_blocking(move || start(settings, service, filter))
        .await
        .map_err(|_| ConfigError("TELEMETRY_ENDPOINT"))?
}
/// Build once at process startup, outside an async runtime's worker thread.
pub fn start(
    settings: TelemetrySettings,
    service: &'static str,
    filter: EnvFilter,
) -> Result<TelemetryGuard, ConfigError> {
    settings.validate()?;
    let writer: Box<dyn std::io::Write + Send> = if let Some(directory) = &settings.log_directory {
        Box::new(
            tracing_appender::rolling::Builder::new()
                .rotation(tracing_appender::rolling::Rotation::HOURLY)
                .filename_prefix(service)
                .filename_suffix("jsonl")
                .max_log_files(24)
                .build(directory)
                .map_err(|_| ConfigError("TELEMETRY_LOG_DIRECTORY"))?,
        )
    } else {
        Box::new(std::io::stdout())
    };
    let (writer, logs) = tracing_appender::non_blocking::NonBlockingBuilder::default()
        .buffered_lines_limit(1024)
        .lossy(true)
        .finish(writer);
    let resource = Resource::builder_empty()
        .with_service_name(service)
        .with_attribute(opentelemetry::KeyValue::new(
            "service.version",
            env!("CARGO_PKG_VERSION"),
        ))
        .build();
    let (traces, metrics) = if let Some(endpoint) = &settings.endpoint {
        let base = endpoint.trim_end_matches('/');
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/traces"))
            .with_timeout(settings.timeout)
            .with_retry_policy(RetryPolicy::disabled())
            .build()
            .map_err(|_| ConfigError("TELEMETRY_ENDPOINT"))?;
        let processor = BatchSpanProcessor::builder(exporter)
            .with_batch_config(
                BatchConfigBuilder::default()
                    .with_max_queue_size(settings.queue_size)
                    .with_max_export_batch_size(64)
                    .with_scheduled_delay(Duration::from_secs(1))
                    .build(),
            )
            .build();
        let provider = SdkTracerProvider::builder()
            .with_resource(resource.clone())
            .with_sampler(Sampler::ParentBased(Box::new(Sampler::AlwaysOn)))
            .with_max_attributes_per_span(24)
            .with_max_events_per_span(16)
            .with_max_attributes_per_event(12)
            .with_max_links_per_span(4)
            .with_span_processor(processor)
            .build();
        let exporter = opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/metrics"))
            .with_timeout(settings.timeout)
            .with_retry_policy(RetryPolicy::disabled())
            .build()
            .map_err(|_| ConfigError("TELEMETRY_ENDPOINT"))?;
        let meter = SdkMeterProvider::builder()
            .with_resource(resource)
            .with_reader(
                PeriodicReader::builder(exporter)
                    .with_interval(settings.metrics_interval)
                    .build(),
            )
            .with_view(|_| Stream::builder().with_cardinality_limit(128).build().ok())
            .build();
        global::set_meter_provider(meter.clone());
        (Some(provider), Some(meter))
    } else {
        (None, None)
    };
    let layer = traces
        .as_ref()
        .map(|provider| tracing_opentelemetry::layer().with_tracer(provider.tracer("labos_threejs")));
    // Third-party transport debug fields can contain URLs/credentials. Only our
    // deliberately safe application events enter either output, even at TRACE.
    let safe_targets =
        tracing_subscriber::filter::filter_fn(|meta| meta.target().starts_with("labos_threejs_"));
    tracing_subscriber::registry()
        .with(filter)
        .with(safe_targets)
        .with(layer)
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .json()
                .with_writer(writer),
        )
        .try_init()
        .map_err(|_| ConfigError("TELEMETRY_ENDPOINT"))?;
    Ok(TelemetryGuard {
        traces,
        metrics,
        _logs: logs,
    })
}

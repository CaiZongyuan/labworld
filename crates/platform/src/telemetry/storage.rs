use crate::object_storage::StorageError;
use tracing::Instrument;

pub(crate) async fn observe<T>(
    operation: &'static str,
    task: impl std::future::Future<Output = Result<T, StorageError>>,
) -> Result<T, StorageError> {
    let span = tracing::info_span!(
        "storage.operation",
        otel.kind = "client",
        operation,
        outcome = tracing::field::Empty
    );
    async {
        let started = std::time::Instant::now();
        let result = task.await;
        let outcome = match &result {
            Ok(_) => "ok",
            Err(StorageError::Expired) => "expired",
            Err(StorageError::Unavailable) => "unavailable",
            Err(StorageError::NotFound) => "not_found",
            Err(StorageError::PreconditionFailed) => "precondition_failed",
            Err(StorageError::TooLarge) => "too_large",
            Err(StorageError::InvalidResponse) => "invalid_response",
        };
        tracing::Span::current().record("outcome", outcome);
        super::metrics::storage_completed(operation, outcome, started.elapsed());
        if result.is_err() {
            tracing::warn!(outcome, "storage operation failed");
        }
        result
    }
    .instrument(span)
    .await
}

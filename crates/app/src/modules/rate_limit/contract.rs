/// Apply the cross-cutting response to Core and to the final composed domain document.
pub fn describe(mut document: utoipa::openapi::OpenApi) -> utoipa::openapi::OpenApi {
    use utoipa::openapi::{Content, Object, Ref, Type, header::Header, response::ResponseBuilder};
    let response = ResponseBuilder::new()
        .description("Request budget exceeded; retry after the specified seconds")
        .content(
            "application/json",
            Content::new(Some(Ref::from_schema_name("ApiErrorResponse"))),
        )
        .header("Retry-After", Header::new(Object::with_type(Type::Integer)))
        .build();
    for (path, item) in &mut document.paths.paths {
        if path == "/health/live" || path == "/health/ready" {
            continue;
        }
        for operation in [
            &mut item.get,
            &mut item.put,
            &mut item.post,
            &mut item.delete,
            &mut item.options,
            &mut item.head,
            &mut item.patch,
            &mut item.trace,
        ]
        .into_iter()
        .flatten()
        {
            operation
                .responses
                .responses
                .insert("429".into(), response.clone().into());
        }
    }
    document
}

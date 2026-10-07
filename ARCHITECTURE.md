# Architecture rules

The architecture spec and approved GitHub tickets define behavior. Lab Word Server owns persistent Core and Lab state in one Node process.

- The Node entry composes public Core/Lab routers and resource owners. Platform supplies PGlite, local bytes and process adapters; pure domains remain independent of infrastructure.
- Platform Core does not import Lab. Node schema declarations and Lab metadata own table/SDK/View boundaries; the retired Knowledge and telemetry stacks are historical.
- PGlite is the persistent source of truth. Startup verifies applied history before migration; readiness must not report an uninitialized database as usable.
- Node HTTP/Zod definitions own the OpenAPI contract. Generate contracts and SDK together; keep handwritten client transport configuration small.
- Shared Views use the SDK and receive platform-specific configuration from the application shell. Platform-independent core helpers do not import browser/native UI runtimes.
- Generate a server request_id and use structured public errors. Never log connection URLs, credentials or arbitrary request query strings.
- Bound external waits. Database readiness failures do not change process liveness.
- Tests observe public behavior: HTTP, user-operable Views and real browser requests. Use real isolated PGlite directories for migration, ownership and recovery behavior.
- Repository Markdown is canonical. Publish only pages in the site manifest, generate snippets/references from real source, and keep projection/build output outside source commits.
- Every behavior change updates its online tutorial and required checks. A buildable stub or a new directory does not prove a capability is delivered.

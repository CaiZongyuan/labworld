# Architecture rules

The target behavior is defined by the architecture spec and approved GitHub tickets. Current Core slices provide system status, self-registration, login, logout and persistent sessions.

- The API entry point composes routers. Platform code supplies configuration, PostgreSQL and telemetry; it does not import application or Knowledge types.
- Keep the removable Knowledge domain separate from Core. Its manifest owns its files; current Core system-status code is not part of the example.
- PostgreSQL is the persistent source of truth. Apply migrations explicitly; readiness must not report an uninitialized database as usable.
- Rust HTTP/DTO definitions own the OpenAPI contract. Generate contracts and SDK together; keep handwritten client transport configuration small.
- Shared Views use the SDK and receive platform-specific configuration from the application shell. Platform-independent core helpers do not import browser/native UI runtimes.
- Generate a server request_id and use structured public errors. Never log connection URLs, credentials or arbitrary request query strings.
- Bound external waits. Database readiness failures do not change process liveness.
- Tests observe public behavior: HTTP, user-operable Views and real browser requests. Use real PostgreSQL for migration and connection behavior.
- Repository Markdown is canonical. Publish only pages in the site manifest, generate snippets/references from real source, and keep projection/build output outside source commits.
- Every behavior change updates its online tutorial and required checks. A buildable stub or a new directory does not prove a capability is delivered.

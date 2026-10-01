# syntax=docker/dockerfile:1
# Production image for the API, Worker and the explicit ops one-shots
# (migrate, bootstrap-storage). TLS and static assets live in Caddy, not here.
FROM rust:1.96-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3 AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY apps apps
# The migrate! macro embeds the migration files at compile time.
COPY migrations migrations
# Registry and target stay in cache mounts: image layers carry only the
# binaries, so a rebuilt commit reuses the dependency and build artifacts.
RUN --mount=type=cache,target=/app/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    CARGO_BUILD_JOBS=4 cargo build --locked --release -p labos-threejs-api -p labos-threejs-worker \
    && mkdir /out \
    && cp target/release/labos-threejs-api target/release/labos-threejs-worker target/release/migrate target/release/bootstrap-storage /out/

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin labos_threejs
COPY --from=build /out/ /usr/local/bin/
# Topology is a deployment decision, not operator config: both processes must
# accept the container network, never loopback-only defaults.
ENV APP_BIND=0.0.0.0:3000
ENV WORKER_BIND=0.0.0.0:3001
USER labos_threejs

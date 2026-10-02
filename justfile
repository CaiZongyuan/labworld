set shell := ["bash", "-euo", "pipefail", "-c"]

# List the commands actually implemented in this revision.
default:
    @just --list

# PostgreSQL/RustFS/Redis/Mailpit in Docker, API reload and Web HMR on the host.
dev:
    node scripts/dev.mjs

# Stop leftover dev processes (API/Worker/Web) still holding the dev ports.
dev-stop:
    node scripts/dev-stop.mjs

services-down:
    docker compose stop postgres rustfs redis mailpit

db-down:
    docker compose stop postgres

migrate:
    node scripts/migrate.mjs

worker:
    node scripts/worker.mjs

bootstrap-storage:
    node scripts/bootstrap-storage.mjs

generate:
    pnpm generate

check:
    cargo fmt --all -- --check
    cargo clippy --locked --workspace --all-targets -- -D warnings
    pnpm format:check
    pnpm lint
    pnpm typecheck
    pnpm contracts:check
    pnpm boundaries:check
    just test
    just perf-ci
    pnpm docs:check
    pnpm build
    pnpm docs:build

# Complete milestone validation, including real Chromium.
check-full: check
    just e2e

# Electron shell GUI smoke against the real stack (also used by the CI job).
desktop-smoke:
    node scripts/desktop-smoke.mjs

# Launch the Electron shell against a running dev web entry (just dev).
desktop:
    node scripts/desktop.mjs

test:
    pnpm test:tooling
    just test-backend
    just test-frontend

test-backend:
    node scripts/test-backend.mjs

test-frontend:
    pnpm test:frontend

e2e:
    pnpm test:e2e

# Public-site browser journeys: the static docs site under the deployed
# base, plus a custom-base smoke. No application stack is involved.
e2e-docs:
    node scripts/e2e-docs.mjs

# The performance entry point of spec §21: print the command index and the
# committed baselines, then run the deterministic evidence. No load,
# saturation or soak belongs here — those are the later report tickets and
# never run implicitly.
perf:
    @echo "== just perf: deterministic performance gates (spec §17) =="
    @echo "Budgets + first baselines: scripts/perf/baselines.json"
    @echo "Reports: .scratch/perf/bundle-report.json, .scratch/perf/query-plans.json"
    @echo "Load/saturation/trajectory/soak reports (nightly evidence, never a gate):"
    @echo "  just perf-load | perf-saturation | perf-trajectory | perf-soak"
    @echo "Desktop renderer soak (nightly evidence, never a gate):"
    @echo "  just perf-desktop-soak"
    @echo "1/2 budget contract tests (registration + documents)"
    node scripts/test-backend.mjs --test perf_registration --test perf_documents
    @echo "2/2 bundle gate + query-plan report"
    just perf-ci

# The bundle gate and the query-plan report — part of `just check`, so the
# main gate covers perf-ci per spec §21. CI uploads the reports as an
# artifact; the budget tests run with the backend suite inside `just test`.
perf-ci:
    node scripts/perf-bundle.mjs
    node scripts/perf-query-plans.mjs

# Load, saturation, trajectory and soak reports (spec §17.3). Each command
# brings up a controlled, disposable stack on free ports (never your dev or
# production data), seeds the fixture dataset, runs the k6 scenario and
# writes .scratch/perf/<scenario>-report.json. Prerequisite tools: Docker
# (for the stack) and k6 (https://grafana.com/docs/k6/latest/set-up/
# install-k6/) — reports in this repository were produced with k6 v2.3.0.
# The stack is torn down with its volumes when the command ends;
# PERF_STACK_KEEP=1 keeps it up for inspection. Never part of `just check`:
# these are nightly/release evidence, not PR gates.
perf-load:
    node scripts/perf/run-scenario.mjs load

perf-saturation:
    node scripts/perf/run-scenario.mjs saturation

perf-trajectory:
    node scripts/perf/run-scenario.mjs trajectory

perf-soak:
    node scripts/perf/run-scenario.mjs soak

# Desktop soak (spec §17.3): drives the real Electron shell over the shared
# knowledge views and samples renderer RSS, heap, DOM nodes and listeners
# into .scratch/perf/desktop-soak-report.json. Prerequisites: pnpm install
# (the shell's pinned Electron downloads on first require) and either a
# display or xvfb. Starts its own disposable PostgreSQL/Redis/RustFS/
# Mailpit stack plus API and web on free ports — never your dev data — and
# tears the containers down when the run ends. Duration/warm-up/sampling:
# DESKTOP_SOAK_DURATION_SECS (300) / DESKTOP_SOAK_WARMUP_SECS (15) /
# DESKTOP_SOAK_SAMPLE_MS (2000). Growth observations are report material:
# they never fail the run. Never part of `just check` — nightly/release
# evidence, not a PR gate.
perf-desktop-soak:
    node scripts/perf/desktop-soak.mjs

docs:
    pnpm docs:dev

docs-check:
    pnpm docs:check

docs-build:
    pnpm docs:build

# Optional local logs, traces, and metrics with the normal runnable application.
dev-observability:
    node scripts/dev.mjs --observability

observability-up:
    node scripts/observability.mjs up

observability-down:
    node scripts/observability.mjs down

observability-validate:
    node scripts/observability.mjs validate

# Single-machine production stack. ENV_FILE points at the operator's
# untracked environment file; see docs/guides/platform.md.
production-build:
    pnpm --filter @labos-threejs/web build
    docker build -f deploy/production/Dockerfile -t labos-threejs-production:local .

production-migrate ENV_FILE=".env.production":
    ENV_FILE={{ENV_FILE}} docker compose -f compose.production.yaml --env-file {{ENV_FILE}} --profile ops run --rm migrate
    ENV_FILE={{ENV_FILE}} docker compose -f compose.production.yaml --env-file {{ENV_FILE}} --profile ops run --rm storage-init

production-up ENV_FILE=".env.production":
    ENV_FILE={{ENV_FILE}} docker compose -f compose.production.yaml --env-file {{ENV_FILE}} up -d --wait postgres redis rustfs
    just production-migrate {{ENV_FILE}}
    ENV_FILE={{ENV_FILE}} docker compose -f compose.production.yaml --env-file {{ENV_FILE}} up -d --wait --wait-timeout 180 api worker caddy

production-down ENV_FILE=".env.production":
    ENV_FILE={{ENV_FILE}} docker compose -f compose.production.yaml --env-file {{ENV_FILE}} down

production-smoke:
    node scripts/production-smoke.mjs

production-backup ENV_FILE=".env.production" ARCHIVE=`printf 'backups/%s' "$(date +%Y%m%d-%H%M%S)"`:
    node scripts/production-backup.mjs --env-file {{ENV_FILE}} --archive {{ARCHIVE}}

production-restore ARCHIVE ENV_FILE=".env.production":
    node scripts/production-restore.mjs --env-file {{ENV_FILE}} --archive {{ARCHIVE}}

production-restore-drill:
    node scripts/production-restore-drill.mjs

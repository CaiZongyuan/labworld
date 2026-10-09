//! Shared infrastructure, independent of application and reference-domain types.
pub mod cache;
pub mod config;
pub mod mail;
pub mod object_storage;
pub mod postgres;
pub mod rate_limit;
mod redis_transport;
pub mod telemetry;

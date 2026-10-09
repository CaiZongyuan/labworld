mod contract;
pub use contract::describe;
mod management;
pub use management::{openapi, router};
mod configuration;
use crate::http::{RequestId, too_many_requests};
use axum::{
    extract::{ConnectInfo, MatchedPath, Request, State},
    middleware::Next,
    response::Response,
};
pub use configuration::FIELDS;
use labos_threejs_platform::{
    config::ConfigError,
    rate_limit::{CounterSettings, WindowCounter},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

pub trait Clock: Send + Sync {
    fn now_millis(&self) -> u64;
}
#[derive(Clone, Copy)]
pub struct Policy {
    pub limit: u32,
    pub fallback_limit: u32,
}
#[derive(Clone)]
pub struct Limits {
    pub registration: Policy,
    pub authentication: Policy,
    pub resource: Policy,
    pub window_secs: u32,
    pub max_local_entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            registration: Policy {
                limit: 20,
                fallback_limit: 5,
            },
            authentication: Policy {
                limit: 60,
                fallback_limit: 20,
            },
            resource: Policy {
                limit: 600,
                fallback_limit: 120,
            },
            window_secs: 60,
            max_local_entries: 4096,
        }
    }
}
#[derive(Clone, Copy, Hash, PartialEq, Eq)]
enum Kind {
    Registration,
    Authentication,
    Resource,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Registration => "registration",
            Self::Authentication => "authentication",
            Self::Resource => "resource",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Registration => 0,
            Self::Authentication => 1,
            Self::Resource => 2,
        }
    }
    fn policy(self, limits: &Limits) -> Policy {
        match self {
            Self::Registration => limits.registration,
            Self::Authentication => limits.authentication,
            Self::Resource => limits.resource,
        }
    }
}
#[derive(Clone, Copy, Default)]
struct Window {
    id: u64,
    count: u32,
}
impl Window {
    fn consume(&mut self, id: u64) -> u32 {
        if self.id != id {
            *self = Self { id, count: 0 };
        }
        self.count = self.count.saturating_add(1);
        self.count
    }
}
#[derive(Default)]
struct Local {
    entries: HashMap<(Kind, [u8; 32]), Window>,
    overflow: [Window; 3],
    last_pruned: u64,
}
impl Local {
    fn consume(&mut self, kind: Kind, client: [u8; 32], window: u64, capacity: usize) -> u32 {
        if self.last_pruned != window {
            self.entries.retain(|_, entry| entry.id == window);
            self.last_pruned = window;
        }
        if let Some(entry) = self.entries.get_mut(&(kind, client)) {
            return entry.consume(window);
        }
        if self.entries.len() >= capacity {
            return self.overflow[kind.index()].consume(window);
        }
        self.entries
            .entry((kind, client))
            .or_default()
            .consume(window)
    }
}
#[derive(Default)]
struct Totals {
    redis_allowed: AtomicU64,
    redis_denied: AtomicU64,
    local_allowed: AtomicU64,
    local_denied: AtomicU64,
    fallbacks: AtomicU64,
}
impl Totals {
    fn local(&self, used: u32, limit: u32) -> bool {
        let allowed = used <= limit;
        if allowed {
            self.local_allowed.fetch_add(1, Ordering::Relaxed);
        } else {
            self.local_denied.fetch_add(1, Ordering::Relaxed);
        }
        allowed
    }
}
struct Inner {
    limits: Limits,
    clock: Arc<dyn Clock>,
    local: Mutex<Local>,
    remote: Option<WindowCounter>,
    totals: [Totals; 3],
}
#[derive(Clone, Default)]
pub struct RateLimiter(Option<Arc<Inner>>);
impl RateLimiter {
    pub fn redis(
        limits: Limits,
        clock: Arc<dyn Clock>,
        settings: CounterSettings,
    ) -> Result<Self, ConfigError> {
        Self::new(limits, clock, Some(WindowCounter::new(settings)?))
    }
    pub fn local(limits: Limits, clock: Arc<dyn Clock>) -> Result<Self, ConfigError> {
        Self::new(limits, clock, None)
    }
    fn new(
        limits: Limits,
        clock: Arc<dyn Clock>,
        remote: Option<WindowCounter>,
    ) -> Result<Self, ConfigError> {
        if !(1..=3600).contains(&limits.window_secs) {
            return Err(ConfigError("RATE_LIMIT_WINDOW_SECS"));
        }
        if !(1..=100_000).contains(&limits.max_local_entries) {
            return Err(ConfigError("RATE_LIMIT_MAX_LOCAL_ENTRIES"));
        }
        for (name, fallback, policy) in [
            (
                "RATE_LIMIT_REGISTRATION",
                "RATE_LIMIT_REGISTRATION_FALLBACK",
                limits.registration,
            ),
            (
                "RATE_LIMIT_AUTHENTICATION",
                "RATE_LIMIT_AUTHENTICATION_FALLBACK",
                limits.authentication,
            ),
            (
                "RATE_LIMIT_RESOURCE",
                "RATE_LIMIT_RESOURCE_FALLBACK",
                limits.resource,
            ),
        ] {
            if policy.limit == 0 || policy.limit > 1_000_000 {
                return Err(ConfigError(name));
            }
            if policy.fallback_limit == 0 || policy.fallback_limit > policy.limit {
                return Err(ConfigError(fallback));
            }
        }
        Ok(Self(Some(Arc::new(Inner {
            limits,
            clock,
            local: Mutex::new(Local::default()),
            remote,
            totals: Default::default(),
        }))))
    }
}
pub async fn enforce(State(limiter): State<RateLimiter>, request: Request, next: Next) -> Response {
    let Some(inner) = &limiter.0 else {
        return next.run(request).await;
    };
    let path = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str);
    if path == "/health/live" || path == "/health/ready" {
        return next.run(request).await;
    }
    let kind = if request.method() == axum::http::Method::POST && path == "/api/v1/auth/register" {
        Kind::Registration
    } else if request.method() == axum::http::Method::POST
        && path.starts_with("/api/v1/auth/")
        && path != "/api/v1/auth/logout"
    {
        Kind::Authentication
    } else {
        Kind::Resource
    };
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.0.ip().to_canonical().to_string())
        .unwrap_or_else(|| "unknown".into());
    let client: [u8; 32] = Sha256::digest(peer.as_bytes()).into();
    let now = inner.clock.now_millis();
    let window_ms = u64::from(inner.limits.window_secs) * 1000;
    let used = inner
        .local
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .consume(
            kind,
            client,
            now / window_ms,
            inner.limits.max_local_entries,
        );
    let policy = kind.policy(&inner.limits);
    let remaining_ms = window_ms - now % window_ms;
    let totals = &inner.totals[kind.index()];
    let allowed = if let Some(remote) = &inner.remote {
        match remote
            .allow(
                kind.name(),
                &client,
                now / window_ms,
                remaining_ms,
                policy.limit,
            )
            .await
        {
            Ok(allowed) => {
                if allowed {
                    totals.redis_allowed.fetch_add(1, Ordering::Relaxed);
                } else {
                    totals.redis_denied.fetch_add(1, Ordering::Relaxed);
                }
                allowed
            }
            Err(_) => {
                totals.fallbacks.fetch_add(1, Ordering::Relaxed);
                totals.local(used, policy.fallback_limit)
            }
        }
    } else {
        totals.local(used, policy.fallback_limit)
    };
    if !allowed {
        let id = request
            .extensions()
            .get::<RequestId>()
            .expect("request context wraps rate limiting")
            .clone();
        return too_many_requests(id, (window_ms - now % window_ms).div_ceil(1000));
    }
    next.run(request).await
}

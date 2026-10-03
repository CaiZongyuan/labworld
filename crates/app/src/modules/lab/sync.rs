use super::{
    Failure, Lab,
    world::{self, LabWorld, PersistentLab, WorldQuery},
};
use crate::http::{ApiPath, RequestId};
use axum::{
    Extension, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response, Sse, sse::Event},
    routing::get,
};
use futures_util::stream;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{collections::BTreeMap, convert::Infallible, time::Duration};
use tokio::sync::{mpsc, watch};
use utoipa::{OpenApi, ToSchema};

const MAX_EVENT_BYTES: usize = 1024 * 1024;
const MAX_PENDING_EVENTS: usize = 8;
const POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorldCollection {
    Entities,
    Nodes,
    Assets,
    Relationships,
}

#[derive(Serialize, ToSchema)]
pub struct WorldChange {
    pub collection: WorldCollection,
    pub id: String,
    /// Changed top-level properties; null removes the item. New items carry all properties.
    pub patch: Option<Value>,
}

#[derive(Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorldEvent {
    Snapshot {
        world: LabWorld,
    },
    Update {
        version: String,
        base_version: String,
        lab: Option<PersistentLab>,
        changes: Vec<WorldChange>,
    },
    Heartbeat {
        version: String,
    },
    Resync {
        reason: String,
    },
    AccessEnded,
    RuntimeStatus {
        available: bool,
    },
}

pub(super) fn routes() -> Router<Lab> {
    Router::new().route("/api/v1/lab/labs/{lab_id}/world/subscribe", get(subscribe))
}
#[derive(OpenApi)]
#[openapi(
    paths(subscribe),
    components(schemas(WorldEvent, WorldChange, WorldCollection))
)]
struct SyncApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    SyncApi::openapi()
}

// Authentication locks precede this clock, which precedes all Lab business locks.
pub(super) async fn lock_world(connection: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT version FROM lab.world_clock WHERE singleton FOR UPDATE")
        .fetch_one(connection)
        .await?;
    Ok(())
}

fn encode(event: &impl Serialize) -> Result<Event, Failure> {
    let data = serde_json::to_string(event).map_err(|_| Failure::Unavailable)?;
    if data.len() > MAX_EVENT_BYTES {
        return Err(Failure::SnapshotTooLarge);
    }
    Ok(Event::default().data(data))
}

fn changes(previous: &Value, current: &Value) -> Vec<WorldChange> {
    let mut changes = Vec::new();
    for (key, collection) in [
        ("entities", WorldCollection::Entities),
        ("nodes", WorldCollection::Nodes),
        ("assets", WorldCollection::Assets),
        ("relationships", WorldCollection::Relationships),
    ] {
        let old = previous[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| (item["id"].as_str().unwrap(), item))
            .collect::<BTreeMap<_, _>>();
        let new = current[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| (item["id"].as_str().unwrap(), item))
            .collect::<BTreeMap<_, _>>();
        for (id, item) in &new {
            let patch = match old.get(id) {
                Some(prior) if *prior == *item => continue,
                Some(prior) => Value::Object(
                    item.as_object()
                        .unwrap()
                        .iter()
                        .filter(|(key, value)| prior.get(*key) != Some(*value))
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                ),
                None => (*item).clone(),
            };
            changes.push(WorldChange {
                collection,
                id: (*id).into(),
                patch: Some(patch),
            });
        }
        for id in old.keys().filter(|id| !new.contains_key(*id)) {
            changes.push(WorldChange {
                collection,
                id: (*id).into(),
                patch: None,
            });
        }
    }
    changes
}
fn resync(reason: &str) -> Value {
    json!(WorldEvent::Resync {
        reason: reason.into()
    })
}
fn discard_queue(receiver: &mut mpsc::Receiver<Event>) {
    receiver.close();
    while receiver.try_recv().is_ok() {}
}

async fn check_access(state: &Lab, headers: &HeaderMap, actor: &str) -> Result<(), Failure> {
    match tokio::time::timeout(Duration::from_secs(3), async {
        let mut tx = state.pool.begin().await?;
        state.access_current(&mut tx, headers, actor).await?;
        tx.commit().await?;
        Ok::<_, Failure>(())
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(Failure::Unavailable),
    }
}

#[utoipa::path(get, path="/api/v1/lab/labs/{lab_id}/world/subscribe", operation_id="streamLabWorld", tag="Lab", params(("lab_id"=String, Path)), responses((status=200, description="SSE snapshot then versioned property updates. 1 MiB/event, 8 queued events; resync discards the queue and closes. Credentials are checked on each 250ms polling cycle and before queued frame delivery; source/check timeouts close the stream.", content_type="text/event-stream", body=WorldEvent), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=413, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn subscribe(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
) -> Response {
    let actor = match state.actor(&headers, &id, false).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let initial = match world::load_world(&state, &lab, WorldQuery::default()).await {
        Ok(world) => world,
        Err(error) => return error.response(id),
    };
    let previous = json!(&initial);
    let snapshot = match encode(&WorldEvent::Snapshot { world: initial }) {
        Ok(event) => event,
        Err(error) => return error.response(id),
    };
    let (sender, receiver) = mpsc::channel(MAX_PENDING_EVENTS);
    let (terminal, ending) = watch::channel(None::<Value>);
    let initial_available = state.runtime_available();
    sender.try_send(snapshot).expect("empty subscription queue");
    sender
        .try_send(
            Event::default().data(
                json!(WorldEvent::RuntimeStatus {
                    available: initial_available
                })
                .to_string(),
            ),
        )
        .expect("initial status queue");
    let consumer_state = state.clone();
    let consumer_headers = headers.clone();
    let consumer_actor = actor.clone();
    tokio::spawn(async move {
        let mut previous = previous;
        let mut available = initial_available;
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = sender.closed() => break, _ = interval.tick() => {} }
            if available != state.runtime_available() {
                available = state.runtime_available();
                if sender
                    .try_send(
                        Event::default()
                            .data(json!(WorldEvent::RuntimeStatus { available }).to_string()),
                    )
                    .is_err()
                {
                    terminal.send_replace(Some(resync("slow_client")));
                    break;
                }
            }
            let result = async {
                check_access(&state, &headers, &actor).await?;
                let revision: String =
                    sqlx::query_scalar("SELECT version::text FROM lab.world_clock WHERE singleton")
                        .fetch_one(&state.pool)
                        .await?;
                if revision == previous["version"].as_str().unwrap() {
                    return Ok::<_, Failure>((WorldEvent::Heartbeat { version: revision }, None));
                }
                let next = world::load_world(&state, &lab, WorldQuery::default()).await?;
                let current = json!(&next);
                let lab = if previous["lab"] == current["lab"] {
                    None
                } else {
                    Some(next.lab)
                };
                let event = WorldEvent::Update {
                    version: next.version,
                    base_version: previous["version"].as_str().unwrap().into(),
                    lab,
                    changes: changes(&previous, &current),
                };
                Ok((event, Some(current)))
            };
            let result = tokio::select! { _=sender.closed()=>break, result=tokio::time::timeout(Duration::from_secs(5), result)=>result.unwrap_or(Err(Failure::Unavailable)) };
            let (event, current) = match result {
                Ok(result) => result,
                Err(Failure::Unauthorized) => {
                    terminal.send_replace(Some(json!(WorldEvent::AccessEnded)));
                    break;
                }
                Err(_) => {
                    terminal.send_replace(Some(resync("source_unavailable")));
                    break;
                }
            };
            let event = match encode(&event) {
                Ok(event) => event,
                Err(_) => {
                    terminal.send_replace(Some(resync("payload_limit")));
                    break;
                }
            };
            match sender.try_send(event) {
                Ok(()) => {
                    if let Some(current) = current {
                        previous = current;
                    }
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    terminal.send_replace(Some(resync("slow_client")));
                    break;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
    });
    let stream = stream::unfold(
        (receiver, ending, false),
        move |(mut receiver, mut ending, done)| {
            let state = consumer_state.clone();
            let headers = consumer_headers.clone();
            let actor = consumer_actor.clone();
            async move {
                if done {
                    return None;
                }
                loop {
                    let terminal = ending.borrow().clone();
                    if let Some(event) = terminal {
                        discard_queue(&mut receiver);
                        return Some((
                            Ok::<_, Infallible>(Event::default().data(event.to_string())),
                            (receiver, ending, true),
                        ));
                    }
                    tokio::select! {
                        biased;
                        changed = ending.changed() => { if changed.is_err() { return None; } },
                        event = receiver.recv() => {
                          let event=event?;
                          let access=check_access(&state,&headers,&actor).await;
                          let terminal=match access {
                            Ok(())=>ending.borrow().clone(),
                            Err(Failure::Unauthorized)=>Some(json!(WorldEvent::AccessEnded)),
                            _=>Some(resync("source_unavailable")),
                          };
                          if let Some(terminal)=terminal {
                            discard_queue(&mut receiver);
                            return Some((Ok(Event::default().data(terminal.to_string())),(receiver,ending,true)));
                          }
                          return Some((Ok(event),(receiver,ending,false)));
                        },
                    }
                }
            }
        },
    );
    Sse::new(stream).into_response()
}

use super::{Failure, world};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgConnection;
use std::collections::{HashMap, HashSet};
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema, PartialEq, Eq, Hash, Clone)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    LocatedIn,
    Contains,
    Simulates,
}
impl RelationshipKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::LocatedIn => "located_in",
            Self::Contains => "contains",
            Self::Simulates => "simulates",
        }
    }
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LayoutRelationship {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub kind: RelationshipKind,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct EntityRelationship {
    pub id: String,
    pub lab_id: String,
    pub source_id: String,
    pub target_id: String,
    pub kind: String,
    pub source: String,
    pub registered_by: String,
    pub registered_at: DateTime<Utc>,
}
pub(super) async fn load(
    connection: &mut PgConnection,
    lab: &str,
) -> Result<Vec<EntityRelationship>, Failure> {
    Ok(sqlx::query_as("SELECT id::text,lab_id::text,source_id::text,target_id::text,kind,source,registered_by::text,registered_at FROM lab.entity_relationships WHERE lab_id=$1::uuid ORDER BY id")
        .bind(lab).fetch_all(connection).await?)
}

pub(super) async fn save(
    connection: &mut PgConnection,
    lab: &str,
    actor: &str,
    relationships: &mut [LayoutRelationship],
) -> Result<(), Failure> {
    if relationships.len() > 1000 {
        return Err(Failure::InvalidInput);
    }
    let mut ids = HashSet::new();
    let mut facts = HashSet::new();
    for relation in relationships.iter_mut() {
        relation.id = world::uuid(&relation.id)?.to_string();
        relation.source_id = world::uuid(&relation.source_id)?.to_string();
        relation.target_id = world::uuid(&relation.target_id)?.to_string();
        if relation.source_id == relation.target_id
            || !ids.insert(relation.id.clone())
            || !facts.insert((
                relation.source_id.clone(),
                relation.target_id.clone(),
                relation.kind.clone(),
            ))
        {
            return Err(Failure::InvalidReference);
        }
    }
    let entities: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id::text,kind,reality,definition_id FROM lab.entities WHERE lab_id=$1::uuid",
    )
    .bind(lab)
    .fetch_all(&mut *connection)
    .await?;
    let entities = entities
        .into_iter()
        .map(|(id, kind, reality, definition)| (id, (kind, reality, definition)))
        .collect::<HashMap<_, _>>();
    let mut parents = HashMap::new();
    for relation in relationships.iter() {
        let source = entities
            .get(&relation.source_id)
            .ok_or(Failure::InvalidReference)?;
        let target = entities
            .get(&relation.target_id)
            .ok_or(Failure::InvalidReference)?;
        let container = match relation.kind {
            RelationshipKind::LocatedIn => {
                Some((&relation.source_id, &relation.target_id, &target.0))
            }
            RelationshipKind::Contains => {
                Some((&relation.target_id, &relation.source_id, &source.0))
            }
            RelationshipKind::Simulates => {
                if source.1 != "simulated" || target.1 != "physical" || source.2 != target.2 {
                    return Err(Failure::InvalidReference);
                }
                None
            }
        };
        if let Some((child, parent, kind)) = container {
            if !matches!(kind.as_str(), "furniture" | "location" | "labware") {
                return Err(Failure::InvalidReference);
            }
            if parents
                .insert(child, parent)
                .is_some_and(|old| old != parent)
            {
                return Err(Failure::InvalidReference);
            }
        }
    }
    // Both spatial kinds describe the same child-to-container graph.
    for child in parents.keys() {
        let mut visited = HashSet::new();
        let mut current = *child;
        while let Some(parent) = parents.get(current) {
            if !visited.insert(current) {
                return Err(Failure::InvalidReference);
            }
            current = parent;
        }
    }
    let existing: Vec<(String,String,String,String,String)> = sqlx::query_as("SELECT id::text,lab_id::text,source_id::text,target_id::text,kind FROM lab.entity_relationships WHERE id::text=ANY($1)")
        .bind(ids.iter().cloned().collect::<Vec<_>>()).fetch_all(&mut *connection).await?;
    let requested = relationships
        .iter()
        .map(|relation| (relation.id.as_str(), relation))
        .collect::<HashMap<_, _>>();
    for (id, owner, source, target, kind) in existing {
        let relation = requested
            .get(id.as_str())
            .ok_or(Failure::InvalidReference)?;
        if owner != lab
            || source != relation.source_id
            || target != relation.target_id
            || relation.kind.as_str() != kind
        {
            return Err(Failure::InvalidReference);
        }
    }
    sqlx::query(
        "DELETE FROM lab.entity_relationships WHERE lab_id=$1::uuid AND NOT(id::text=ANY($2))",
    )
    .bind(lab)
    .bind(ids.into_iter().collect::<Vec<_>>())
    .execute(&mut *connection)
    .await?;
    let saved=sqlx::query("INSERT INTO lab.entity_relationships(id,lab_id,source_id,target_id,kind,registered_by) SELECT r.id::uuid,$1::uuid,r.source_id::uuid,r.target_id::uuid,r.kind,$3::uuid FROM jsonb_to_recordset($2) AS r(id text,source_id text,target_id text,kind text) ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id WHERE entity_relationships.lab_id=EXCLUDED.lab_id AND entity_relationships.source_id=EXCLUDED.source_id AND entity_relationships.target_id=EXCLUDED.target_id AND entity_relationships.kind=EXCLUDED.kind")
        .bind(lab).bind(json!(relationships)).bind(actor).execute(connection).await?;
    if saved.rows_affected() != relationships.len() as u64 {
        return Err(Failure::InvalidReference);
    }
    Ok(())
}

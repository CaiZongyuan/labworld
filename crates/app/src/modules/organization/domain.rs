use super::MemberRole;

#[derive(Clone, Copy)]
pub struct MembershipState {
    pub role: MemberRole,
    pub active: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ChangeError {
    Forbidden,
    LastOwner,
}

pub fn can_manage(actor: MemberRole, target: MemberRole) -> bool {
    actor == MemberRole::Owner || (actor == MemberRole::Admin && target != MemberRole::Owner)
}

/// Call inside the organization's serialized membership transaction.
pub fn validate_change(
    actor: MemberRole,
    current: MembershipState,
    next: MembershipState,
    active_owners: u64,
) -> Result<(), ChangeError> {
    if !can_manage(actor, current.role) || !can_manage(actor, next.role) {
        return Err(ChangeError::Forbidden);
    }
    if current.active
        && current.role == MemberRole::Owner
        && !(next.active && next.role == MemberRole::Owner)
        && active_owners <= 1
    {
        return Err(ChangeError::LastOwner);
    }
    Ok(())
}

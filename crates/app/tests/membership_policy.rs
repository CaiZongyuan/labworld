use labos_threejs_app::modules::organization::{
    MemberRole::{Admin, Member, Owner},
    domain::{ChangeError, MembershipState, validate_change},
};

#[test]
fn owner_transitions_preserve_an_active_owner_and_keep_admins_below_owners() {
    let active = |role| MembershipState { role, active: true };
    let inactive = |role| MembershipState {
        role,
        active: false,
    };
    for (actor, current, next, owners, expected) in [
        (
            Owner,
            active(Owner),
            active(Member),
            1,
            Err(ChangeError::LastOwner),
        ),
        (
            Owner,
            active(Owner),
            inactive(Owner),
            1,
            Err(ChangeError::LastOwner),
        ),
        (Owner, active(Owner), active(Owner), 1, Ok(())),
        (Owner, active(Owner), active(Admin), 2, Ok(())),
        (Owner, inactive(Owner), active(Member), 1, Ok(())),
        (
            Admin,
            active(Member),
            active(Owner),
            1,
            Err(ChangeError::Forbidden),
        ),
        (
            Admin,
            inactive(Owner),
            active(Owner),
            1,
            Err(ChangeError::Forbidden),
        ),
        (Admin, active(Member), inactive(Member), 1, Ok(())),
        (
            Member,
            active(Member),
            active(Admin),
            1,
            Err(ChangeError::Forbidden),
        ),
    ] {
        assert_eq!(validate_change(actor, current, next, owners), expected);
    }
}

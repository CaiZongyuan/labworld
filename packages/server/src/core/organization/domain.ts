import type { MemberRole } from '../identity/domain.ts';
export const canManage = (actor: MemberRole, target: MemberRole) =>
  actor === 'owner' || (actor === 'admin' && target !== 'owner');
export function changeAllowed(
  actor: MemberRole,
  current: { role: MemberRole; active: boolean },
  next: { role: MemberRole; active: boolean },
  activeOwners: number,
) {
  if (!canManage(actor, current.role) || !canManage(actor, next.role))
    return 'forbidden';
  if (
    current.active &&
    current.role === 'owner' &&
    !(next.active && next.role === 'owner') &&
    activeOwners <= 1
  )
    return 'last_owner';
  return undefined;
}

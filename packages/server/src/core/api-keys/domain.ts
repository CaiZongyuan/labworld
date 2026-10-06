import { trimmed } from '../identity/email.ts';
export type KeyScope = { id: string; label: string };
export type CreateKey = {
  name: string;
  scopes: string[];
  expires_in_days: number;
};
export const secretPrefix = 'labos_threejs_key_';
export function normalizeKey(input: CreateKey, supported: readonly KeyScope[]) {
  const name = trimmed(input.name);
  const scopes = [...new Set(input.scopes)].sort();
  if (
    !name ||
    [...name].length > 100 ||
    name.includes('\0') ||
    !Number.isInteger(input.expires_in_days) ||
    input.expires_in_days < 1 ||
    input.expires_in_days > 365 ||
    !scopes.length ||
    scopes.length > 16 ||
    scopes.some((scope) => !supported.some((value) => value.id === scope))
  )
    return undefined;
  return { name, scopes, days: input.expires_in_days };
}

export type MemberRole = 'owner' | 'admin' | 'member';
export type CurrentUser = {
  id: string;
  email: string;
  display_name: string | null;
  role: MemberRole;
};
export type CurrentSession = { user: CurrentUser; csrf_token: string };
export type Registration = {
  email: string;
  password: string;
  display_name?: string | null;
};
export type AuthPolicy = {
  origin: string;
  absoluteSecs: number;
  idleSecs: number;
  secureCookie: boolean;
};
export function registration(input: Registration) {
  const email = input.email.trim();
  const displayName = input.display_name?.trim() || null;
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    [...input.password].length < 12 ||
    [...input.password].length > 128 ||
    (displayName !== null && [...displayName].length > 80)
  )
    return undefined;
  return { email, normalizedEmail: email.toLowerCase(), displayName };
}

// Retained parser: email_address 0.2.9 default options (display, literals, dotless domains).
// Identity stores the trimmed original; normalization is only for uniqueness/login.
export const trimmed = (value: string) =>
  value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
export const utf8Size = (value: string) =>
  new TextEncoder().encode(value).byteLength;
const alphanumeric = (value: string) =>
  value !== undefined && /^[\p{Alphabetic}\p{Number}]$/u.test(value);
function retainedNonAscii(value: string) {
  const code = value.codePointAt(0)!;
  return (
    code >>> 8 >= 0xc2 &&
    code >>> 8 <= 0xdf &&
    (code & 255) >= 0x80 &&
    (code & 255) <= 0xbf
  );
}
function atom(value: string) {
  return (
    value.length > 0 &&
    [...value].every(
      (character) =>
        alphanumeric(character) ||
        "!#$%&'*+-/=?^_`{|}~".includes(character) ||
        retainedNonAscii(character),
    )
  );
}
function quoted(value: string) {
  const characters = [...value];
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    const code = character.codePointAt(0)!;
    if (character === '\\') {
      const next = characters[++index]?.codePointAt(0);
      if (next === undefined || next < 0x21 || next > 0x7e) return false;
    } else if (!(
      character === ' ' ||
      character === '\t' ||
      code === 0x21 ||
      (code >= 0x23 && code <= 0x5b) ||
      (code >= 0x5d && code <= 0x7e) ||
      retainedNonAscii(character)
    ))
      return false;
  }
  return true;
}
export function validEmail(value: string) {
  let address = value;
  const display = address.lastIndexOf(' <');
  if (display >= 0) {
    const right = trimmed(address.slice(display + 2));
    if (!right.endsWith('>') || !trimmed(address.slice(0, display)))
      return false;
    address = right.slice(0, -1);
  }
  const separator = address.lastIndexOf('@');
  if (separator < 0) return false;
  const local = address.slice(0, separator);
  const domain = address.slice(separator + 1);
  if (!local || utf8Size(local) > 64 || !domain || utf8Size(domain) > 254)
    return false;
  if (local.startsWith('"') && local.endsWith('"')) {
    if (utf8Size(local) <= 2 || !quoted(local.slice(1, -1))) return false;
  } else if (!local.split('.').every(atom)) return false;
  if (domain.startsWith('[') && domain.endsWith(']'))
    return [...domain.slice(1, -1)].every((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code >= 0x21 && code <= 0x5a) ||
        (code >= 0x5e && code <= 0x7e) ||
        retainedNonAscii(character)
      );
    });
  return domain.split('.').every((label) => {
    const characters = [...label];
    return (
      utf8Size(label) <= 63 &&
      atom(label) &&
      alphanumeric(characters[0]) &&
      alphanumeric(characters.at(-1)!)
    );
  });
}

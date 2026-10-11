import { readFile } from 'node:fs/promises';
export { publishPressureRequest } from '../../tests/support/pressure-barrier.ts';

/** Diagnostic decode/dispatch has its own failure boundary and no native close path. */
export async function dispatchPressureRequest(path, dispatch, read = readFile) {
  try {
    const request = JSON.parse(await read(path, 'utf8'));
    if (
      request.action !== 'observer-health-barrier' ||
      !/^[0-9a-f-]{36}$/.test(request.request_id ?? '') ||
      !Number.isSafeInteger(request.expected_owner_pid) ||
      request.expected_owner_pid < 1
    )
      return false;
    await dispatch(request);
    return true;
  } catch {
    return false;
  }
}

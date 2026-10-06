import { customType, timestamp } from 'drizzle-orm/pg-core';
// No timestamp takes the JavaScript Date path: it cannot hold microseconds.
export const instant = (name: string) =>
  timestamp(name, { mode: 'string', withTimezone: true, precision: 6 });
export const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

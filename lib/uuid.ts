const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every route and the queue consumer check ids with this before they reach SQL.
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

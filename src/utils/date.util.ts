/**
 * Returns the current date-time as an ISO 8601 string.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Converts a Date object to an ISO 8601 string.
 */
export function toISO(date: Date): string {
  return date.toISOString();
}

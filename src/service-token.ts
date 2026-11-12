/** Service-to-service bearer tokens must be long enough to resist guessing. */
export const MIN_SERVICE_TOKEN_LENGTH = 32;

export function isStrongServiceToken(value: string | undefined | null): value is string {
  return typeof value === "string" && value.length >= MIN_SERVICE_TOKEN_LENGTH;
}

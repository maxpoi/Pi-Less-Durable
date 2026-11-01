const ID_PATTERN = /^[A-Za-z0-9_+=.()[\]{}!@#$%^&-]+$/u;

export const MAX_ID_LENGTH = 200;

/** Validate one exact Room or Agent identity that may become a filesystem component. */
export function assertIdentityId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!value) throw new Error(`${label} must not be empty`);
  if (value === "." || value === "..") {
    throw new Error(`${label} must not be "." or ".."`);
  }
  if (!ID_PATTERN.test(value)) {
    throw new Error(
      `${label} must contain only letters, numbers, or _-+=.()[]{}!@#$%^&`,
    );
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must not exceed ${MAX_ID_LENGTH} ASCII characters`);
  }
}

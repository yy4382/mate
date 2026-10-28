/** The fewest UTF-8 bytes a password may have. Clients check it before asking; the shell enforces it. */
export const MIN_PASSWORD_BYTES = 12;

export const passwordTooShort = (password: string) =>
  new TextEncoder().encode(password).length < MIN_PASSWORD_BYTES;

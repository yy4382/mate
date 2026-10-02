export const modelCredentialSchema = `
CREATE TABLE model_credentials (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL CHECK(length(api_key) > 0),
  updated_at INTEGER NOT NULL
);
`;

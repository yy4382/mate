/** Store the per-operation version last confirmed by the paired node. */
export const recoveryVersionsSchemaV22 = `
ALTER TABLE owner_agent_process_operations ADD COLUMN node_receipt_revision INTEGER
  CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1);
ALTER TABLE owner_agent_stop_intents ADD COLUMN node_receipt_revision INTEGER
  CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1);
ALTER TABLE owner_privileged_approvals ADD COLUMN node_receipt_revision INTEGER
  CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1);
`;

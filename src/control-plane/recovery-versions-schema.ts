/** Store the per-operation version last confirmed by the paired node. */
export const recoveryVersionsSchema = `
ALTER TABLE owner_agent_process_operations ADD COLUMN node_receipt_revision INTEGER
  CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1);
ALTER TABLE owner_agent_stop_intents ADD COLUMN node_receipt_revision INTEGER
  CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1);
`;

/**
 * Revision 22 as the old release left it: the same two operation ledgers plus the privileged
 * command approval table this release removes. It stays frozen here because it is the template the
 * migration machinery compares a real, older database against before upgrading it to revision 25.
 */
export const recoveryVersionsSchemaV22 = `${recoveryVersionsSchema}
ALTER TABLE owner_privileged_approvals ADD COLUMN node_receipt_revision INTEGER
  CHECK(node_receipt_revision IS NULL OR node_receipt_revision >= 1);
`;

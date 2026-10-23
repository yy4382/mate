# Store fixture: v0.1.0-alpha.2

The data directory (`data-directory/`) that Mate at `v0.1.0-alpha.2` (commit `7c0e904fc897cd3cd902d02e5e9bc5eb36084e40`) writes, built through that
version's own public module APIs. Tests copy it and start the current code on the copy.

Regenerate with `node scripts/make-store-fixture.ts v0.1.0-alpha.2 tests/fixtures/stores/v0.1.0-alpha.2`.

It is test data, not a secret. The owner logs in with the password `fixture owner password`. `facts.json` holds that
password and the other values the tests check.

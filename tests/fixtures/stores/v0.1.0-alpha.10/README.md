# Store fixture: v0.1.0-alpha.10

The data directory (`data-directory/`) that Mate at `v0.1.0-alpha.10` (commit `adc269bb21e9a3faf4eb5c93dd631a080945aed8`) writes, built through that
version's own public module APIs. Tests copy it and start the current code on the copy.

Regenerate with `node scripts/make-store-fixture.ts v0.1.0-alpha.10 tests/fixtures/stores/v0.1.0-alpha.10`.

It is test data, not a secret. The owner logs in with the password `fixture owner password`. `facts.json` holds that
password and the other values the tests check.

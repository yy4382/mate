import { cpSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "./temporary-directory.ts";

/** What `scripts/make-store-fixture.ts` recorded about the data it built, for a test to check against. */
export type StoreFacts = {
  readonly ownerPassword: string;
  readonly openaiApiKey: string;
  readonly pairingToken: string;
  /** The Agents' chat accounts' external IDs. */
  readonly agentExternalIds: readonly string[];
  /** The endpoint of the owner's Web Push subscription. */
  readonly pushEndpoint: string;
  /** What the owner's unread summary reported when the fixture was built. */
  readonly ownerUnread: {
    readonly total: number;
    readonly mentions: number;
    readonly timelines: number;
  };
};

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/stores");

/**
 * A private copy of the data directory a released version wrote (`tests/fixtures/stores/<version>`), removed when the
 * current test finishes, so a test can open it and change it without touching the fixture. `destination` is where the
 * copy goes when the test needs the directory at a particular path.
 */
export function storeFixture(
  version: string,
  destination = join(temporaryDirectory(), "data"),
): { readonly dataDirectory: string; readonly facts: StoreFacts } {
  const fixture = join(FIXTURES, version);
  cpSync(join(fixture, "data-directory"), destination, { recursive: true });
  const facts = JSON.parse(readFileSync(join(fixture, "facts.json"), "utf8")) as StoreFacts;
  return { dataDirectory: destination, facts };
}

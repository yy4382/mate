import { readFileSync } from "node:fs";
import { z } from "zod";

const packageVersionSchema = z.object({ version: z.string() });
const version = (url: URL) =>
  packageVersionSchema.parse(JSON.parse(readFileSync(url, "utf8"))).version;

/** Installed package identities, recorded without credentials when a run is admitted. */
export const runtimeVersions = {
  controlPlane: version(new URL("../../package.json", import.meta.url)),
  piDurable: version(new URL("../package.json", import.meta.resolve("@earendil-works/pi-durable"))),
  piAi: version(new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai"))),
  chord: version(new URL("../package.json", import.meta.resolve("@earendil-works/chord"))),
};

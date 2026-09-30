import { fileURLToPath } from "node:url";

/** Absolute path to this package's built static web assets. */
export const webRoot = fileURLToPath(new URL("./dist/", import.meta.url));

import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The built web client: a directory of static files whose `index.html` is the single-page app. Any page path that is
 * not a file gets `index.html`, and the client routes it.
 */
export class Frontend {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  /** The file `pathname` names inside the directory, if it is one; never a path outside it. */
  file(pathname: string): string | undefined {
    try {
      const file = join(this.#directory, decodeURIComponent(pathname));
      const inside = relative(this.#directory, file);
      if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) return undefined;
      return statSync(file).isFile() ? file : undefined;
    } catch {
      return undefined;
    }
  }

  /** The app's entry page, if the client is built. */
  get index(): string | undefined {
    return this.file("/index.html");
  }

  serve(response: ServerResponse, file: string): void {
    const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
    // The entry page names the current build's assets, so it is always fetched fresh.
    const cache = extname(file) === ".html" ? "no-cache" : "public, max-age=3600";
    response.writeHead(200, { "content-type": type, "cache-control": cache });
    createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
  }
}

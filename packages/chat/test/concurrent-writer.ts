import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { ChatApp } from "../src/index.ts";

/**
 * A second process's worth of writes on the same chat.sqlite, run on its own thread so that its commits land while
 * the test's thread is in the middle of its own reads.
 */
const { file, author, timeline, count } = z
  .object({
    file: z.string(),
    author: z.number(),
    timeline: z.object({ conversation: z.number() }),
    count: z.number(),
  })
  .parse(workerData);
const app = new ChatApp(file);
for (let index = 1; index <= count; index++)
  app.send(author, timeline, { requestId: `writer-${index}`, body: `m${index}`, freshness: false });
app.close();
parentPort?.postMessage("done");

// Compiled fixture is the only synthetic subprocess entrypoint; production never selects it.
process.env.MATE_WORKER = '0';
const { serveWorker } = await import('../../src/runtime/worker.js');
const { Engine } = await import('../../src/runtime/engine.js');
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const { model, answer } = await import('./pi.js');
let calls = 0;
serveWorker(new Engine({ ...model, contextWindow: 100000 }, (_model, context) => {
  const stream = createAssistantMessageEventStream();
  const message = answer([{ type: 'text', text: JSON.stringify({ calls: ++calls, context, env: Object.keys(process.env), pid: process.pid }) }]);
  stream.push({ type: 'done', reason: 'stop', message }); return stream;
}));

// Test-only process entry; production never selects synthetic streams.
process.env.MATE_WORKER='0';
const {serveWorker}=await import('../../src/runtime/worker.js');
const {Engine}=await import('../../src/runtime/engine.js');
const {model,answer,scripted}=await import('./pi.js');
class CompactingEngine extends Engine{
 override run(spec:import('../../src/runtime/engine.js').RunSpec,hooks:import('../../src/runtime/engine.js').EngineHooks){return super.run(spec,{...hooks,summarize:async()=> 'synthetic compacted history'});}
}
serveWorker(new CompactingEngine({...model,contextWindow:20000},async(m,c,o)=>scripted([answer([{type:'text',text:JSON.stringify(c)}])])(m,c,o)));

import type {Admission} from '../concurrency/admission.js';
import type {ExecutionBackend,ExecutionRequest,ExecutionResult} from './backend.js';

export class AdmittedBackend implements ExecutionBackend {
  constructor(readonly backend:ExecutionBackend,readonly admission:Admission){}
  async execute(request:ExecutionRequest,signal?:AbortSignal):Promise<ExecutionResult>{
    const release=await this.admission.acquire(signal);
    try{signal?.throwIfAborted();return await this.backend.execute(request,signal);}finally{release();}
  }
}

type Progress = Readonly<{phase:'scan'|'record'|'ready';bytes:number;total:number;records:number}>;
type Listener = (event:Progress)=>void;
type Job<T> = {controller:AbortController;listeners:Set<Listener>;promise:Promise<T>;latest?:Progress;settled:boolean};

/** Hover statistics and explicit opening share the same scan. Cancelling one
 * view detaches that view; the scan stops when its last consumer leaves. */
export class ContainerIndexRequests<T> {
  readonly #jobs = new Map<string, Job<T>>();

  run(key:string, signal:AbortSignal, progress:Listener,
    load:(signal:AbortSignal,progress:Listener)=>Promise<T>):Promise<T> {
    signal.throwIfAborted();
    let job = this.#jobs.get(key);
    if (!job) {
      const controller = new AbortController(), listeners = new Set<Listener>();
      const current:Job<T> = {controller,listeners,promise:undefined!,settled:false};
      current.promise = Promise.resolve().then(() => load(controller.signal, event => {
        current.latest = event;
        for (const listener of current.listeners) listener(event);
      })).finally(() => {
        current.settled = true;
        if (this.#jobs.get(key) === current) this.#jobs.delete(key);
      });
      job = current; this.#jobs.set(key, current);
    }
    const current = job;
    return new Promise<T>((resolve,reject) => {
      let finished = false;
      const listener:Listener = event => progress(event);
      const leave = () => {
        if (finished) return false;
        finished = true; signal.removeEventListener('abort',abort); current.listeners.delete(listener);
        if (!current.settled && !current.listeners.size) {
          if (this.#jobs.get(key) === current) this.#jobs.delete(key);
          current.controller.abort();
        }
        return true;
      };
      const abort = () => { if (leave()) reject(signal.reason ?? new DOMException('Index cancelled','AbortError')); };
      current.listeners.add(listener); signal.addEventListener('abort',abort,{once:true});
      if (current.latest) progress(current.latest);
      current.promise.then(value => { if (leave()) resolve(value); }, error => { if (leave()) reject(error); });
    });
  }

  async close():Promise<void> {
    const jobs = [...this.#jobs.values()]; this.#jobs.clear();
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map(job => job.promise));
  }
}

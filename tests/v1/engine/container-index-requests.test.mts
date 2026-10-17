import assert from 'node:assert/strict';
import test from 'node:test';
import {ContainerIndexRequests} from '../../../src/engine/container-index-requests.mts';
const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
test('hover/open join one index; progress is replayed; one cancellation does not cancel the other',async()=>{
  const requests=new ContainerIndexRequests<number>(), a=new AbortController(),b=new AbortController();
  let loads=0,finish!:(value:number)=>void, signal!:AbortSignal;
  const events:number[]=[];
  const load=async(s:AbortSignal,p:(e:any)=>void)=>{loads++;signal=s;p({phase:'scan',bytes:1,total:10,records:0});return new Promise<number>(r=>{finish=r;});};
  const one=requests.run('same',a.signal,()=>{},load); const cancelled=assert.rejects(one,{name:'AbortError'});
  await tick();const two=requests.run('same',b.signal,e=>events.push(e.bytes),load);
  a.abort();await cancelled;assert.equal(signal.aborted,false);assert.deepEqual(events,[1]);finish(2);
  assert.equal(await two,2);assert.equal(loads,1);await requests.close();
});
test('last consumer cancellation aborts scan; retry and forced rebuild have independent work',async()=>{
  const requests=new ContainerIndexRequests<number>(), cancel=new AbortController();let first!:AbortSignal;
  const abandoned=requests.run('file',cancel.signal,()=>{},async s=>{first=s;await new Promise<void>((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));return 1;});
  const rejected=assert.rejects(abandoned,{name:'AbortError'});await tick();cancel.abort();await rejected;assert(first.aborted);
  assert.deepEqual(await Promise.all(['file','file:rebuild'].map((k,i)=>requests.run(k,new AbortController().signal,()=>{},async()=>i))),[0,1]);
  await requests.close();
});
test('failed shared indexing is not retained as a successful cache',async()=>{
  const r=new ContainerIndexRequests<number>();let n=0;const signal=new AbortController().signal;
  const fail=async()=>{n++;throw new Error('broken zip');};
  await Promise.all([assert.rejects(r.run('x',signal,()=>{},fail),/broken zip/),assert.rejects(r.run('x',signal,()=>{},fail),/broken zip/)]);
  assert.equal(n,1);assert.equal(await r.run('x',signal,()=>{},async()=>9),9);await r.close();
});

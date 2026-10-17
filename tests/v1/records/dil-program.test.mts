import assert from "node:assert/strict";
import test from "node:test";
import { DilSession, parseDilProgram, dilVisibleText } from "../../../src/core/records/dil-program.mts";

const source = `DIL.render(__dil.jsx(()=>{
 const __dilConstants=DIL.useConstants();
 const [amount,setAmount]=DIL.useState(12,{key:"amount"});
 const [selected,setSelected]=DIL.useState([],{key:"selected"});
 return __dil.jsx(__dil.Fragment,null,
  __dil.jsx("box",null,__dil.jsx("text",null,amount),__dil.jsx("slider",{value:amount,onChange:setAmount})),
  __dil.jsx("box",null,__dil.jsx("text",null,amount**2),__dil.jsx("button",{onClick:()=>setAmount(5)},__dilConstants["reset"])),
  __dil.jsx("box",null,__dil.jsx("checkbox",{checked:selected.includes("a"),onChange:v=>setSelected(a=>v?[...new Set([...a,"a"])]:a.filter(x=>x!=="a"))})),
  __dil.jsx("svg",{viewBox:"0 0 100 100"},__dil.jsx("path",{d:Array.from({length:3},(_,i)=>i+":"+Math.sin(i+amount).toFixed(2)).join(" ")}))
 );}));`;

test("separate UI views share one source message state without mutating captured values", () => {
  const captured={amount:62}, session=new DilSession(source,{reset:"Reset"},{},captured);
  assert.equal(session.program.roots.length,4); assert.equal(session.render(0).children[0].children[0],62);
  session.dispatch(session.render(0).children[1].props.onChange,[63]);
  assert.equal(session.render(1).children[0].children[0],3969);
  session.dispatch(session.render(1).children[1].props.onClick);
  assert.equal(session.render(0).children[1].props.value,5); assert.deepEqual(captured,{amount:62});
  assert.equal(new DilSession(source,{reset:"Reset"}).render(0).children[0].children[0],12);
});
test("local functional setters, SVG arithmetic and array closures preserve their dependencies", () => {
  const session=new DilSession(source,{reset:"Reset"});
  const handle=()=>session.render(2).children[0];
  session.dispatch(handle().props.onChange,[true]); session.dispatch(handle().props.onChange,[true]);
  assert.deepEqual(session.state["selected"],["a"]); assert.equal(handle().props.checked,true);
  session.dispatch(handle().props.onChange,[false]); assert.equal(handle().props.checked,false);
  const path=session.render(3).children[0].props.d; session.dispatch(session.render(0).children[1].props.onChange,[1]);
  assert.notEqual(session.render(3).children[0].props.d,path); assert.deepEqual(session.failures,[]);
});
test("Parser syntax inspection does not evaluate programs, while Reader refuses host/global access", () => {
  const evil='DIL.render(__dil.jsx(()=>{const x=globalThis.fetch("https://example.invalid");return __dil.jsx("text",null,"kept");}));';
  const program=parseDilProgram(evil); assert.equal(dilVisibleText(program.roots[0]!,{}),"kept");
  assert.throws(()=>new DilSession(evil,{}),/Unsupported UI identifier/);
  const escape='DIL.render(__dil.jsx(()=>{return __dil.jsx("text",null,({}).constructor.constructor("return globalThis")());}));';
  assert.throws(()=>new DilSession(escape,{}).render(0),/Unsupported UI property/);
});
test("bounded computations cannot allocate arbitrary collections or invoke unknown constructors", () => {
  for (const expr of ['Array.from({length:1000000000})','new Function("return 1")','Math.random()']) {
    assert.throws(()=>new DilSession(`DIL.render(__dil.jsx(()=>{return __dil.jsx("text",null,${expr});}));`,{}).render(0));
  }
});

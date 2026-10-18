import { parse } from "acorn";
import type { JsonObject, JsonValue } from "../contracts/types.mts";

// Acorn nodes are untrusted syntax, never callable JavaScript. The interpreter
// below exposes only explicit pure operations and local state setters.
export type DilAst = { type: string; start: number; end: number; [key: string]: any };
export const DIL_VIEW_FORMAT = "cloudig/dil-view/1";
export const DIL_SOURCE_FORMAT = "cloudig/dil-source/1";
export const DIL_LIMITS = Object.freeze({ steps: 250_000, collection: 10_000, depth: 256 });
export type DilProgram = Readonly<{ source: string; roots: readonly DilAst[]; body: readonly DilAst[]; functions: readonly DilAst[] }>;
export type DilNode = { tag: string; props: Record<string, any>; children: any[]; key: string };
type Closure = { closure: true; params: DilAst[]; body: DilAst; env: Record<string, any> };
const denied = new Set(["__proto__", "prototype", "constructor", "caller", "callee", "arguments"]);
const safeKey = (key: unknown): string => { const name = String(key); if (denied.has(name)) throw new TypeError("Unsupported UI property"); return name; };
export function walkDil(node: DilAst, visit: (node: DilAst) => void): void {
  const pending: DilAst[] = [node];
  while (pending.length) { const n = pending.pop()!; if (!n || typeof n !== "object") continue; if (typeof n.type === "string") visit(n);
    for (const [key, value] of Object.entries(n)) if (!["start", "end", "loc"].includes(key)) {
      if (Array.isArray(value)) pending.push(...value.filter(v => v && typeof v === "object"));
      else if (value && typeof value === "object") pending.push(value as DilAst);
    }
  }
}
export function unwrapDil(node: DilAst): DilAst {
  return node?.type === "CallExpression" && node["callee"]?.name === "__dilSafe" && node["arguments"]?.[0]?.type === "ArrowFunctionExpression"
    ? unwrapDil(node["arguments"][0].body) : node;
}
export const isDilJsx = (n: DilAst): boolean => n?.type === "CallExpression" && n["callee"]?.object?.name === "__dil" && n["callee"]?.property?.name === "jsx";
export function parseDilProgram(source: string): DilProgram {
  const ast = parse(source, { ecmaVersion: "latest" }) as unknown as DilAst;
  const calls = ast["body"].filter((n: DilAst) => n.type === "ExpressionStatement" && n["expression"]?.callee?.object?.name === "DIL" && n["expression"].callee.property?.name === "render");
  if (calls.length !== 1) throw new TypeError("UI source must contain one DIL.render root");
  const render = calls[0].expression.arguments[0] as DilAst;
  const fn = isDilJsx(render) ? render["arguments"][0] as DilAst : undefined;
  const body: DilAst[] = fn && ["ArrowFunctionExpression", "FunctionExpression"].includes(fn.type) && fn["body"]?.type === "BlockStatement" ? fn["body"].body : [];
  const returned = body.find(n => n.type === "ReturnStatement")?.["argument"] ?? render;
  const root = unwrapDil(returned);
  const fragment = isDilJsx(root) && root["arguments"][0]?.property?.name === "Fragment";
  return { source, roots: fragment ? root["arguments"].slice(2) : [root], body: body.filter(n => n.type !== "ReturnStatement"), functions: ast["body"].filter((n: DilAst) => n.type === "FunctionDeclaration") };
}

/** Literal lookup for Parser placement. No expression/handler is executed. */
export function dilLiteral(node: DilAst | undefined, constants: JsonObject): JsonValue | undefined {
  if (!node) return;
  if (node.type === "Literal") return node["value"];
  if (node.type === "MemberExpression" && node["object"]?.name === "__dilConstants") return constants[String(node["property"]?.value)];
  if (node.type === "ObjectExpression") {
    const value: JsonObject = {};
    for (const p of node["properties"] as DilAst[]) { if (p.type !== "Property" || p["computed"]) return; const item = dilLiteral(p["value"], constants); if (item === undefined) return; value[safeKey(p["key"].name ?? p["key"].value)] = item; }
    return value;
  }
  if (node.type === "ArrayExpression") { const values = (node["elements"] as DilAst[]).map(n => dilLiteral(n, constants)); if (values.some(v => v === undefined)) return; return values as JsonValue[]; }
  return;
}
export function dilVisibleText(root: DilAst, constants: JsonObject): string {
  const values: string[] = [];
  function visit(n: DilAst): void {
    n = unwrapDil(n); if (!n) return;
    if (isDilJsx(n)) { for (const child of n["arguments"].slice(2) as DilAst[]) visit(child); return; }
    const literal = dilLiteral(n, constants); if (typeof literal === "string") { values.push(literal); return; }
    if (n.type === "ConditionalExpression") { visit(n["consequent"]); visit(n["alternate"]); }
  }
  visit(root); return values.filter(Boolean).join("\n");
}

/** A bounded evaluator for captured declarative UI, with no eval, DOM, network,
 * imports, timers or access to JavaScript prototypes. AppBlock code is separate. */
export class DilSession {
  readonly state: Record<string, any> = Object.create(null);
  readonly program: DilProgram;
  readonly failures: string[] = [];
  #constants: JsonObject; #appData: JsonObject; #env: Record<string, any> = Object.create(null);
  #steps = 0; #depth = 0; #dirty = true; #listeners = new Set<() => void>();
  constructor(source: string, constants: JsonObject, appData: JsonObject = {}, captured: JsonObject = {}) {
    this.program = parseDilProgram(source); this.#constants = constants; this.#appData = appData;
    Object.assign(this.state, structuredClone(captured)); this.#prepare();
  }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #prepare(): void {
    this.#steps = 0; this.#depth = 0; this.#env = Object.create(null);
    for (const fn of this.program.functions) this.#env[safeKey(fn["id"].name)] = this.#closure(fn, this.#env);
    for (const statement of this.program.body) this.#eval(statement, this.#env);
    this.#dirty = false;
  }
  render(index: number): any { if (this.#dirty) this.#prepare(); else { this.#steps = 0; this.#depth = 0; } const root = this.program.roots[index]; if (!root) throw new RangeError("Unknown UI view"); return this.#eval(root, this.#env); }
  dispatch(handler: unknown, args: unknown[] = []): unknown {
    this.#steps = 0; this.#depth = 0; const result = this.#call(handler as any, args);
    for (const listener of this.#listeners) listener(); return result;
  }
  #closure(node: DilAst, env: Record<string, any>): Closure { return { closure: true, params: node["params"], body: node["body"], env }; }
  #bind(pattern: DilAst, value: any, env: Record<string, any>): void {
    if (pattern.type === "Identifier") { env[safeKey(pattern["name"])] = value; return; }
    if (pattern.type === "AssignmentPattern") { this.#bind(pattern["left"], value === undefined ? this.#eval(pattern["right"], env) : value, env); return; }
    if (pattern.type === "ArrayPattern") { pattern["elements"].forEach((p: DilAst, i: number) => { if (p) this.#bind(p, value?.[i], env); }); return; }
    if (pattern.type === "ObjectPattern") { for (const p of pattern["properties"] as DilAst[]) this.#bind(p["value"], value?.[safeKey(p["key"].name ?? p["key"].value)], env); return; }
    throw new TypeError(`Unsupported UI binding: ${pattern.type}`);
  }
  #get(name: string, env: Record<string, any>): any {
    safeKey(name); if (Object.hasOwn(env, name)) return env[name];
    if (name === "undefined") return undefined;
    if (name === "NaN") return NaN;
    if (["Math", "Array", "Object", "JSON", "String", "Number", "Boolean", "Set", "GenUI"].includes(name)) return { builtin: name };
    // Native resolved components are descriptors, never globally callable objects.
    if (["AsyncImage", "AsyncImageGroup", "Cite", "MemoryCite", "SuggestAutomation", "Entity", "Link"].includes(name)) return { component: name };
    throw new TypeError(`Unsupported UI identifier: ${name}`);
  }
  #call(fn: any, args: any[]): any {
    if (fn?.setter) { this.state[fn.setter] = args[0]?.closure ? this.#call(args[0], [this.state[fn.setter]]) : args[0]; this.#dirty = true; return; }
    if (fn?.closure) {
      if (++this.#depth > DIL_LIMITS.depth) throw new RangeError("UI call budget exceeded");
      try { const env = { ...fn.env }; fn.params.forEach((p: DilAst, i: number) => this.#bind(p, args[i], env)); return this.#eval(fn.body, env); }
      finally { this.#depth--; }
    }
    throw new TypeError("Unsupported UI callback");
  }
  #array(value: any): any[] { const a = value instanceof Set ? [...value] : Array.isArray(value) ? value : typeof value === "string" ? [...value] : []; if (a.length > DIL_LIMITS.collection) throw new RangeError("UI collection budget exceeded"); return a; }
  #eval(n: DilAst | undefined, env: Record<string, any>): any {
    if (++this.#steps > DIL_LIMITS.steps) throw new RangeError("UI expression budget exceeded");
    if (!n) return undefined;
    switch (n.type) {
      case "Literal": if (n["regex"] || n["bigint"]) throw new TypeError("Unsupported UI literal"); return n["value"];
      case "Identifier": return this.#get(n["name"], env);
      case "VariableDeclaration": for (const d of n["declarations"] as DilAst[]) {
        const init = d["init"], id = d["id"];
        if (id.type === "ArrayPattern" && init?.callee?.object?.name === "DIL" && init.callee.property?.name === "useState") {
          const key = init.arguments[1] ? this.#eval(init.arguments[1], env)?.key : id.elements[0].name;
          safeKey(key); if (!Object.hasOwn(this.state, key)) this.state[key] = this.#eval(init.arguments[0], env);
          this.#bind(id, [this.state[key], { setter: key }], env);
        } else this.#bind(id, this.#eval(init, env), env);
      } return undefined;
      case "ArrayExpression": return n["elements"].flatMap((v: DilAst) => v?.type === "SpreadElement" ? this.#array(this.#eval(v["argument"], env)) : [this.#eval(v, env)]);
      case "ObjectExpression": { const o = Object.create(null); for (const p of n["properties"] as DilAst[]) {
        if (p.type === "SpreadElement") { for (const [k, v] of Object.entries(this.#eval(p["argument"], env) ?? {})) o[safeKey(k)] = v; }
        else if (p.type === "Property") o[safeKey(p["computed"] ? this.#eval(p["key"], env) : p["key"].name ?? p["key"].value)] = this.#eval(p["value"], env);
        else throw new TypeError("Unsupported UI object property");
      } return o; }
      case "MemberExpression": {
        if (n["object"]?.name === "__dil" && n["property"]?.name === "Fragment") return { component: "fragment" };
        const object = this.#eval(n["object"], env), key = safeKey(n["computed"] ? this.#eval(n["property"], env) : n["property"].name);
        if (object == null) { if (n["optional"]) return; throw new TypeError("Missing UI property owner"); }
        if (object?.builtin === "Math" && ["PI", "E", "LN2", "LN10", "SQRT2"].includes(key)) return (Math as any)[key];
        return Object.hasOwn(Object(object), key) || key === "length" ? object[key] : undefined;
      }
      case "ChainExpression": return this.#eval(n["expression"], env);
      case "UnaryExpression": { const v = this.#eval(n["argument"], env); switch (n["operator"]) { case "!": return !v; case "-": return -v; case "+": return +v; case "typeof": return v?.closure || v?.setter ? "function" : typeof v; case "void": return undefined; default: throw new TypeError("Unsupported UI unary operator"); } }
      case "BinaryExpression": case "LogicalExpression": {
        const a = this.#eval(n["left"], env), op = n["operator"];
        if (op === "&&") return a && this.#eval(n["right"], env); if (op === "||") return a || this.#eval(n["right"], env); if (op === "??") return a ?? this.#eval(n["right"], env);
        const b = this.#eval(n["right"], env);
        switch (op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b; case "%": return a % b; case "**": return a ** b;
          case "===": return a === b; case "!==": return a !== b; case "==": return a == b; case "!=": return a != b; case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b; default: throw new TypeError(`Unsupported UI operator: ${op}`); }
      }
      case "ConditionalExpression": return this.#eval(n["test"], env) ? this.#eval(n["consequent"], env) : this.#eval(n["alternate"], env);
      case "TemplateLiteral": return n["quasis"].map((q: any, i: number) => q.value.cooked + (i < n["expressions"].length ? this.#eval(n["expressions"][i], env) : "")).join("");
      case "TaggedTemplateExpression": if (n["tag"]?.object?.name === "String" && n["tag"]?.property?.name === "raw") return n["quasi"].quasis.map((q: any, i: number) => q.value.raw + (i < n["quasi"].expressions.length ? this.#eval(n["quasi"].expressions[i], env) : "")).join(""); throw new TypeError("Unsupported UI template tag");
      case "ArrowFunctionExpression": case "FunctionExpression": return this.#closure(n, env);
      case "BlockStatement": { for (const s of n["body"] as DilAst[]) { if (s.type === "ReturnStatement") return this.#eval(s["argument"], env); this.#eval(s, env); } return undefined; }
      case "ExpressionStatement": return this.#eval(n["expression"], env);
      case "SequenceExpression": { let v; for (const x of n["expressions"] as DilAst[]) v = this.#eval(x, env); return v; }
      case "NewExpression": if (n["callee"]?.name === "Set") return new Set(this.#array(this.#eval(n["arguments"][0], env))); throw new TypeError("Unsupported UI constructor");
      case "CallExpression": return this.#invoke(n, env);
      default: throw new TypeError(`Unsupported UI syntax: ${n.type}`);
    }
  }
  #invoke(n: DilAst, env: Record<string, any>): any {
    const c = n["callee"], args = () => (n["arguments"] as DilAst[]).flatMap(a => a.type === "SpreadElement" ? this.#array(this.#eval(a["argument"], env)) : [this.#eval(a, env)]);
    if (c.type === "Identifier" && c.name === "__dilSafe") {
      try { return this.#call(this.#eval(n["arguments"][0], env), []); }
      catch (error) { const message = error instanceof Error ? error.message : String(error); if (!this.failures.includes(message)) this.failures.push(message); return this.#eval(n["arguments"][1], env); }
    }
    if (isDilJsx(n)) {
      const tag = this.#eval(n["arguments"][0], env), props = this.#eval(n["arguments"][1], env) ?? {};
      const children = n["arguments"].slice(2).map((a: DilAst) => this.#eval(a, env)).flat(Infinity).filter((v: any) => v != null && typeof v !== "boolean");
      if (tag?.closure) return this.#call(tag, [{ ...props, children }]);
      return { tag: typeof tag === "string" ? tag : tag?.component, props, children, key: props.key == null ? String(n.start) : `${n.start}:${String(props.key)}` } satisfies DilNode;
    }
    if (c.type === "MemberExpression" && c.object?.name === "DIL") {
      if (c.property?.name === "useConstants") return this.#constants;
      if (c.property?.name === "useAppData") return this.#call(this.#eval(n["arguments"][0], env), [this.#appData]);
      throw new TypeError("Unsupported UI hook");
    }
    if (c.type === "Identifier" && ["String", "Number", "Boolean"].includes(c.name)) { const a = args()[0]; return c.name === "String" ? String(a) : c.name === "Number" ? Number(a) : Boolean(a); }
    if (c.type !== "MemberExpression") return this.#call(this.#eval(c, env), args());
    const owner = this.#eval(c.object, env), method = safeKey(c.computed ? this.#eval(c.property, env) : c.property.name), a = args();
    if (owner == null && (c.optional || n["optional"])) return;
    if (owner?.builtin) switch (owner.builtin) {
      case "Math": if (["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "exp", "log", "log10", "abs", "round", "floor", "ceil", "min", "max", "pow", "sign", "trunc"].includes(method)) return (Math as any)[method](...a); break;
      case "Number": if (method === "isFinite") return Number.isFinite(a[0]); if (method === "isInteger") return Number.isInteger(a[0]); break;
      case "Array": if (method === "isArray") return Array.isArray(a[0]); if (method === "from") { const values = a[0] && Number.isSafeInteger(a[0].length) && !Array.isArray(a[0]) ? new Array(Math.max(0, Math.min(DIL_LIMITS.collection, a[0].length))).fill(undefined) : this.#array(a[0]); if (a[0]?.length > DIL_LIMITS.collection) throw new RangeError("UI collection budget exceeded"); return a[1] ? values.map((v, i) => this.#call(a[1], [v, i])) : values; } break;
      case "Object": if (method === "entries") return Object.entries(a[0] ?? {}).filter(([k]) => !denied.has(k)); if (method === "keys") return Object.keys(a[0] ?? {}).filter(k => !denied.has(k)); if (method === "values") return Object.entries(a[0] ?? {}).filter(([k]) => !denied.has(k)).map(([,v]) => v); if (method === "fromEntries") return Object.fromEntries(this.#array(a[0]).map(([k,v]) => [safeKey(k),v])); break;
      case "JSON": if (method === "stringify") return JSON.stringify(a[0], null, a[2]); break;
      case "GenUI": if (method === "copy" || method === "openUrl") return { action: method, value: String(a[0] ?? "") }; break;
    }
    if (Array.isArray(owner)) { this.#array(owner); switch (method) {
      case "map": return owner.map((v,i) => this.#call(a[0],[v,i])); case "filter": return owner.filter((v,i) => this.#call(a[0],[v,i])); case "every": return owner.every((v,i) => this.#call(a[0],[v,i])); case "some": return owner.some((v,i) => this.#call(a[0],[v,i]));
      case "includes": return owner.includes(a[0]); case "join": return owner.join(a[0]); case "slice": return owner.slice(...a); case "find": return owner.find((v,i) => this.#call(a[0],[v,i])); case "indexOf": return owner.indexOf(a[0]);
    } }
    if (typeof owner === "string" && ["padStart", "padEnd"].includes(method)) {
      const length = Number(a[0]);
      if (!Number.isSafeInteger(length) || length < 0 || length > DIL_LIMITS.collection || a[1] !== undefined && typeof a[1] !== "string") throw new RangeError("UI string padding budget exceeded");
      return method === "padStart" ? owner.padStart(length, a[1]) : owner.padEnd(length, a[1]);
    }
    if (typeof owner === "string" && ["trim", "toLowerCase", "toUpperCase", "includes", "startsWith", "endsWith", "slice", "split", "replaceAll"].includes(method) && a.every(v=>v==null||["string","number","boolean"].includes(typeof v))) return (String.prototype as any)[method].apply(owner,a);
    if (typeof owner === "number" && method === "toFixed" && Number.isInteger(a[0]) && a[0] >= 0 && a[0] <= 100) return owner.toFixed(a[0]);
    if (owner instanceof Set && method === "has") return owner.has(a[0]);
    throw new TypeError(`Unsupported UI method: ${method}`);
  }
}

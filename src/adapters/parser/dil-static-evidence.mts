import { dilLiteral, unwrapDil, type DilAst, DIL_LIMITS } from "../../core/records/dil-program.mts";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";

/** Expand only literal-array .map templates for matching saved HTML evidence.
 * No program body, expression, handler or state callback is executed, and the
 * saved DIL remains unchanged. Dynamic arrays retain their original syntax. */
export function staticDilEvidence(root: DilAst, constants: JsonObject): DilAst {
  let steps = 0, order = 0;
  const literal = (value: JsonValue): DilAst => value !== null && typeof value === "object"
    ? Array.isArray(value) ? { type: "ArrayExpression", start: 0, end: 0, elements: value.map(literal) }
      : { type: "ObjectExpression", start: 0, end: 0, properties: Object.entries(value).map(([key, value]) => ({ type: "Property", start: 0, end: 0, computed: false, key: literal(key), value: literal(value) })) }
    : { type: "Literal", start: 0, end: 0, value };
  const resolve = (node: DilAst | undefined, scope: ReadonlyMap<string, JsonValue>): JsonValue | undefined => {
    if (node?.type === "Identifier" && scope.has(node["name"])) return scope.get(node["name"]);
    if (node?.type === "MemberExpression") {
      const owner = resolve(node["object"], scope), key = node["computed"] ? dilLiteral(node["property"], constants) : node["property"]?.name;
      if (owner !== null && typeof owner === "object" && typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key) && Object.hasOwn(owner, key)) return (owner as JsonObject)[key];
    }
    return dilLiteral(node, constants);
  };
  const expand = (node: DilAst, scope: ReadonlyMap<string, JsonValue>, depth: number): DilAst => {
    if (++steps > DIL_LIMITS.steps || depth > DIL_LIMITS.depth) throw new RangeError("Static UI evidence budget exceeded");
    const unwrapped = unwrapDil(node), call = unwrapped?.type === "CallExpression" ? unwrapped : undefined;
    const receiver = call?.["callee"]?.type === "MemberExpression" && call["callee"].property?.name === "map" ? resolve(call["callee"].object, scope) : undefined;
    const fn = call?.["arguments"]?.[0];
    if (Array.isArray(receiver) && receiver.length <= DIL_LIMITS.collection && call?.["arguments"].length === 1 && fn?.type === "ArrowFunctionExpression" && fn.params.length === 1 && fn.params[0].type === "Identifier" && fn.body.type !== "BlockStatement") {
      return { type: "CallExpression", start: node.start, end: node.end, callee: { type: "MemberExpression", object: { type: "Identifier", name: "__dil" }, property: { type: "Identifier", name: "jsx" } }, arguments: [
        { type: "MemberExpression", object: { type: "Identifier", name: "__dil" }, property: { type: "Identifier", name: "Fragment" } }, literal(null),
        ...receiver.map(value => expand(fn.body, new Map([...scope, [fn.params[0].name, value]]), depth + 1))
      ] };
    }
    if (["Identifier", "MemberExpression"].includes(node.type)) { const value = resolve(node, scope); if (value !== undefined) return literal(value); }
    let inner = scope;
    if (["ArrowFunctionExpression", "FunctionExpression"].includes(node.type)) { inner = new Map(scope); for (const p of node["params"] ?? []) if (p.type === "Identifier") (inner as Map<string, JsonValue>).delete(p.name); }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, ["start", "end", "loc"].includes(key) ? value : Array.isArray(value) ? value.map(v => v && typeof v === "object" && typeof v.type === "string" ? expand(v, inner, depth + 1) : v) : value && typeof value === "object" && typeof value.type === "string" ? expand(value, inner, depth + 1) : value])) as DilAst;
  };
  const result = expand(root, new Map(), 0);
  const number = (node: DilAst) => {
    node.start = ++order;
    for (const [key, value] of Object.entries(node)) if (!["start", "end", "loc"].includes(key)) {
      if (Array.isArray(value)) { for (const v of value) if (v && typeof v === "object" && typeof v.type === "string") number(v); }
      else if (value && typeof value === "object" && typeof value.type === "string") number(value as DilAst);
    }
  };
  number(result); return result;
}

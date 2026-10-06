import type { DefaultTreeAdapterTypes } from "parse5";
import type { JsonObject, JsonValue } from "../../core/contracts/types.mts";
import { isJsonObject } from "../../core/contracts/types.mts";

/** Claude Full/Tree transport references only. Never rewrites raw source/code. */
export class ClaudeResourceData {
  readonly #enabled: boolean;
  readonly #data: JsonObject;

  constructor(payload: JsonObject, enabled: boolean) {
    this.#enabled = enabled;
    const data = enabled ? payload["resource_data"] : undefined;
    if (data !== undefined && !isJsonObject(data)) throw new TypeError("Claude resource_data must be a data URL dictionary");
    this.#data = data ?? {};
  }

  resolve(reference: JsonValue | undefined): string {
    if (typeof reference !== "string" || !reference || !Object.hasOwn(this.#data, reference)) {
      throw new TypeError("Claude embedded resource reference is missing or invalid");
    }
    const value = this.#data[reference];
    if (typeof value !== "string" || !/^data:[^,]*,/iu.test(value)) {
      throw new TypeError("Claude embedded resource reference must resolve to a data URL");
    }
    return value;
  }

  restore(record: JsonObject, fields: Readonly<Record<string, string>>): JsonObject {
    if (!this.#enabled) return record;
    let restored = record;
    for (const [field, reference] of Object.entries(fields)) {
      if (record[reference] === undefined) continue;
      const data = this.resolve(record[reference]);
      const direct = record[field];
      if (direct !== undefined && direct !== null && direct !== "" && direct !== data) {
        throw new TypeError("Claude embedded resource literal and reference disagree");
      }
      if (restored === record) restored = { ...record };
      restored[field] = data;
    }
    return restored;
  }

  /** Only mutate the fresh parse5 reading fragment, never a payload string. */
  restoreReading(fragment: DefaultTreeAdapterTypes.ParentNode): void {
    if (!this.#enabled) return;
    const pending: DefaultTreeAdapterTypes.ParentNode[] = [fragment];
    while (pending.length) {
      const parent = pending.pop()!;
      for (const child of parent.childNodes) {
        if (!("tagName" in child) || ["script", "style", "template", "pre", "code"].includes(child.tagName)) continue;
        const field = child.tagName === "img" ? "src"
          : child.tagName === "a" && child.attrs.some(a => a.name === "download") ? "href" : undefined;
        if (field) {
          const refName = `data-osis-data-${field}`;
          const ref = child.attrs.find(a => a.name === refName);
          if (ref) {
            const data = this.resolve(ref.value);
            const direct = child.attrs.find(a => a.name === field);
            if (direct?.value && direct.value !== data) throw new TypeError("Claude reading resource literal and reference disagree");
            if (direct) direct.value = data;
            else child.attrs.push({ name: field, value: data });
            child.attrs = child.attrs.filter(a => a.name !== refName);
          }
        }
        pending.push(child);
      }
    }
  }
}

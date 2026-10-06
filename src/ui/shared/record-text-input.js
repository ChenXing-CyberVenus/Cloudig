import { RECORD_TEXT_LIMITS, withinRecordTextLimit } from "./record-text-limits.js";

const validators = new WeakMap();
export function refreshRecordTextInputs(root) {
  for (const input of root.querySelectorAll("[data-record-text-limit]")) validators.get(input)?.();
}

export function bindRecordTextInput(input, kind = "name") {
  const limit = RECORD_TEXT_LIMITS[kind];
  if (!Number.isInteger(limit)) throw new TypeError("Unknown record text limit");
  // Native maxlength counts UTF-16 units and would reject half the allowed
  // non-BMP characters. Do not silently cut pasted or composed user text.
  input.removeAttribute("maxlength");
  input.dataset.recordTextLimit = String(limit);
  const validate = () => input.setCustomValidity(withinRecordTextLimit(input.value, limit) ? "" :
    (document.documentElement.lang.startsWith("en") ? `Use at most ${limit} Unicode characters.` : `最多可填写 ${limit} 个 Unicode 字符。`));
  input.addEventListener("input", validate);
  input.addEventListener("compositionend", validate);
  validators.set(input, validate);
  validate();
  return validate;
}

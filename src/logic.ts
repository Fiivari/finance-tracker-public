// Loads gas/Logic.js (plain Apps Script code, no modules) into a sandbox, so local tooling computes exactly what
// the Sheet will. logic.categorizeAll(...), logic.DEFAULT_CATEGORIES etc. resolve names in that sandbox.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadLogic(): Record<string, any> {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../gas/Logic.js", import.meta.url), "utf8"), context, { filename: "gas/Logic.js" });
  return new Proxy({}, { get: (_, name) => vm.runInContext(String(name), context) });
}

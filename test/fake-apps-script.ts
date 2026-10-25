// A small in-memory stand-in for the Apps Script services the gas/ code uses, so the sync can run in Node.
import { createHash, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

type Cell = unknown;

class FakeRange {
  sheet: FakeSheet;
  row: number;
  col: number;
  rows: number;
  cols: number;
  constructor(sheet: FakeSheet, row: number, col: number, rows: number, cols: number) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.rows = rows;
    this.cols = cols;
  }
  getValues(): Cell[][] {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.cols }, (_, c) => this.sheet.data[this.row - 1 + r]?.[this.col - 1 + c] ?? ""),
    );
  }
  setValues(values: Cell[][]) {
    if (values.length !== this.rows || values.some((r) => r.length !== this.cols)) throw new Error("setValues size mismatch");
    values.forEach((r, i) =>
      r.forEach((v, j) => {
        // Like Sheets: a leading apostrophe forces text and isn't part of the value; "=…" would be a formula.
        if (typeof v === "string" && v.startsWith("=")) this.sheet.formulas++;
        this.sheet.set(this.row + i, this.col + j, typeof v === "string" && v.startsWith("'") ? v.slice(1) : v);
      }),
    );
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) this.sheet.set(this.row + r, this.col + c, "");
    this.sheet.trim();
    return this;
  }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
  setNumberFormats(formats: string[][]) {
    if (formats.length !== this.rows) throw new Error("setNumberFormats size mismatch");
    return this;
  }
  setDataValidation() { return this; }
}

export class FakeSheet {
  name: string;
  data: Cell[][] = [];
  formulas = 0;
  constructor(name: string) {
    this.name = name;
  }
  set(row: number, col: number, v: Cell) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  trim() {
    while (this.data.length && this.data[this.data.length - 1].every((v) => v === "" || v == null)) this.data.pop();
  }
  getLastRow() {
    this.trim();
    return this.data.length;
  }
  getName() { return this.name; }
  getRange(a: number | string, col?: number, rows = 1, cols = 1) {
    if (typeof a === "string") {
      const m = /^([A-Z])(\d+):([A-Z])(\d*)$/.exec(a);
      if (!m) throw new Error(`Unsupported range ${a}`);
      const c1 = m[1].charCodeAt(0) - 64;
      const c2 = m[3].charCodeAt(0) - 64;
      return new FakeRange(this, Number(m[2]), c1, Math.max(this.data.length - Number(m[2]) + 1, 1), c2 - c1 + 1);
    }
    return new FakeRange(this, a, col!, rows, cols);
  }
  setFrozenRows() {}
  insertRowAfter(row: number) {
    this.data.splice(row, 0, []);
  }
  deleteRows(start: number, count: number) {
    this.data.splice(start - 1, count);
  }
  rows(): Cell[][] {
    return this.data.slice(1);
  }
}

export interface FakeEnv {
  context: vm.Context;
  sheets: Map<string, FakeSheet>;
  props: Map<string, string>;
  requests: { method: string; url: string; auth: string; body?: string }[];
  run(code: string): any;
}

// bank(method, path, body) returns the JSON response for each Enable Banking request.
export function loadAppsScript(bank: (method: string, path: string, body: any) => unknown, now = () => new Date()): FakeEnv {
  const sheets = new Map<string, FakeSheet>([["Sheet1", new FakeSheet("Sheet1")]]);
  const props = new Map<string, string>();
  const cache = new Map<string, string>();
  const requests: FakeEnv["requests"] = [];
  const ss = {
    getSheetByName: (n: string) => sheets.get(n) ?? null,
    insertSheet: (n: string) => {
      const s = new FakeSheet(n);
      sheets.set(n, s);
      return s;
    },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s: FakeSheet) => sheets.delete(s.name),
    setActiveSheet: () => {},
    moveActiveSheet: () => {},
  };
  const validationBuilder = { requireValueInRange: () => validationBuilder, setAllowInvalid: () => validationBuilder, build: () => ({}) };
  const toSigned = (buf: Buffer) => [...buf].map((b) => (b > 127 ? b - 256 : b));
  const context = vm.createContext({
    SpreadsheetApp: { getActive: () => ss, newDataValidation: () => validationBuilder, getUi: () => ({}) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => props.get(k) ?? null,
        setProperty: (k: string, v: string) => props.set(k, v),
        setProperties: (o: Record<string, string>) => Object.entries(o).forEach(([k, v]) => props.set(k, v)),
      }),
    },
    CacheService: {
      getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => cache.set(k, v), remove: (k: string) => cache.delete(k) }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => "Europe/Helsinki" },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_alg: string, value: string) => toSigned(createHash("sha256").update(value, "utf8").digest()),
      base64EncodeWebSafe: (v: string | number[]) =>
        (typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v.map((b) => (b + 256) % 256))).toString("base64url") + "=",
      computeRsaSha256Signature: (value: string, key: string) => toSigned(sign("sha256", Buffer.from(value), key)),
      formatDate: (d: Date, tz: string, pattern: string) => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
            .formatToParts(d)
            .map((p) => [p.type, p.value]),
        );
        return pattern.replace("yyyy", parts.year).replace("MM", parts.month).replace("dd", parts.day).replace("HH", parts.hour).replace("mm", parts.minute);
      },
      getUuid: () => randomUUID(),
      base64Decode: (v: string) => toSigned(Buffer.from(v, "base64")),
      newBlob: (bytes: number[]) => ({ getDataAsString: () => Buffer.from(bytes.map((b) => (b + 256) % 256)).toString("utf8") }),
    },
    UrlFetchApp: {
      fetch: (url: string, opts: { method: string; headers: Record<string, string>; payload?: string }) => {
        requests.push({ method: opts.method, url, auth: opts.headers.Authorization, body: opts.payload });
        const path = url.replace("https://api.enablebanking.com", "");
        const body = bank(opts.method, path, opts.payload ? JSON.parse(opts.payload) : undefined);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => {
        const builder = { timeBased: () => builder, everyHours: () => builder, create: () => ({}) };
        return builder;
      },
    },
    Date: class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) super(now().getTime());
        else super(...(args as [any]));
      }
      static now() {
        return now().getTime();
      }
    },
  });
  for (const file of ["Logic.js", "Bank.js", "Sheets.js", "Sync.js", "Menu.js", "Web.js"]) {
    vm.runInContext(readFileSync(`gas/${file}`, "utf8"), context, { filename: `gas/${file}` });
  }
  return { context, sheets, props, requests, run: (code: string) => vm.runInContext(code, context) };
}

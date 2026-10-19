#!/usr/bin/env bun
/**
 * Mini-apps v2 conformance v0 (MINIAPPS-PLATFORM-v2-design.md section 5.3, section 8 Phase 0 item 5).
 * The developer runs it on their manifest; CI runs it AGAIN on the PR itself and reads the conformance.json
 * that its own run wrote. A conformance.json is self-attested (anyone can hand-write one): never trust a
 * committed or uploaded copy; regenerate it.
 *
 *   bun run conformance -- mini-apps/<id>/manifest.json [--fixtures <dir>] [--out <path>] [--base <git ref>]
 *
 * Phase 0 runs section 5.3 items 1, 4 (template, static part) and 5. Items 2-3 (service reachability and
 * budgets against a live service) and the rest of item 4 (the fake cp: wrong draftId, changed hash, no
 * grant, idempotency) are Phase 1: they are listed as not_run, never as a pass.
 *
 * Item 1  manifest.validator_pin  the ONE shared validator (scripts/mini-apps-manifests.cjs, P0-1) and the
 *                                 schema file hash to mini-apps/manifests.pins.json; a mismatch REFUSES
 *                                 (exit 2, no conformance.json). The bytes hashed are the bytes run.
 *         manifest.schema         strict JSON (no duplicate keys), then validateManifest(); id = its directory
 *         skills.sha256           every skills[].sha256 is sha256 of the file's bytes
 *         version.bump            with --base: the semver bump covers the diff class (major for a widened op,
 *                                 budget, auth/service, data, events or summary; an input-schema edit of
 *                                 annotations only is a patch); a downgrade (1.0.0 -> 1.0.0-rc.1 too) fails;
 *                                 a base blob that is not in the local object store (a blob-less partial
 *                                 clone) REFUSES; without --base: not_run
 * Item 4  approval.prepare_pair   static: every needs-card op names a prepare-class op of this manifest
 *         approval.summary_render not_run "renderer_absent": no section 3.2 renderer exists in Node or Python
 *                                 yet (Phase 1 item 6); v0 never renders a card itself
 * Item 5  hygiene.fixtures        the fixture layout below is closed
 *         hygiene.secrets         no key or string matches a secret pattern (the note never echoes it)
 *         hygiene.duplicate_keys  every fixture is strict JSON with no duplicate key at any depth
 *         hygiene.error_bodies    every error fixture is exactly {code, detail} with code from a closed set
 *
 * Fixtures (--fixtures <dir>; default mini-apps/<id>/fixtures/ when present; none: item 5 is not_run):
 *   <dir>/<operation name>/<name>.json   one response body the service returns for that op
 *   a file whose name starts with "error" is an error body; every other file is a success body.
 * No symlinks, no other files, no nested directories, no file over the op's maxResponseBytes.
 *
 * conformance.json (--out): {manifest, sha256, results: [{check, pass, note}], passed}. `manifest` is the
 * repo-relative path; `sha256` is over the manifest file's exact bytes. A not_run check has pass null.
 * `passed` is true only when every check that ran passed, and item 1 (pin, schema, skills) and item 5 ran.
 * Output: the summary always goes to stdout. A file is written ONLY with --out, and never by default:
 * --out may not be the manifest, or anywhere inside the manifest's repo or the tool's root (compared by
 * dev+ino, and case-folded on a case-insensitive filesystem), so CI writes it to a temp dir, e.g.
 * --out "$RUNNER_TEMP/conformance.json". Every argument is checked before any file is touched: an
 * argument refusal (exit 2) changes nothing. A file already at --out must be this manifest's own
 * conformance.json (anything else is refused and left alone); it is removed before the run, and the new
 * report is written to a temp file renamed into place only on exit 0 or 1. On any other exit 2, only a
 * file that parses as this manifest's conformance.json is removed. So read the exit code, never the file.
 * Exit codes: 0 passed, 1 failed, 2 refused (bad arguments, a validator pin mismatch, a base blob that is
 * not local, an unsafe --out, an internal error).
 * No network, no credentials: it reads local files and, for --base only, the local git object store.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type Result = { check: string; pass: boolean | null; note: string };
export type Report = { manifest: string; sha256: string; results: Result[]; passed: boolean };
export class Refusal extends Error {
  constructor(public reason: string) { super(reason); }
}

/** Every check, in output order. REQUIRED must have run (pass not null) for `passed`. */
export const CHECKS = [
  "manifest.validator_pin", "manifest.schema", "skills.sha256", "version.bump",
  "service.reachability", "service.budgets",
  "approval.prepare_pair", "approval.summary_render", "approval.fake_cp",
  "hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies",
] as const;
export const REQUIRED = new Set<string>([
  "manifest.validator_pin", "manifest.schema", "skills.sha256",
  "hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies",
]);
const pass = (check: string, note: string): Result => ({ check, pass: true, note });
const fail = (check: string, note: string): Result => ({ check, pass: false, note });
const notRun = (check: string, note: string): Result => ({ check, pass: null, note });

/** passed: every check that ran passed, and every REQUIRED check ran. not_run (null) is never a pass. */
export function passedOf(results: Result[]): boolean {
  if (!results.length) return false;
  if (![...REQUIRED].every(check => results.some(r => r.check === check && r.pass === true))) return false;
  return results.every(r => r.pass === true || (r.pass === null && !REQUIRED.has(r.check)));
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 1 << 20;
const MAX_FIXTURE_FILES = 2000;
const MAX_NOTE_ITEMS = 12;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ---- The shared validator, loaded from the exact bytes its pin names -------------------------------
export type Validator = {
  MANIFEST_VERSION: number;
  validateManifest: (value: unknown, opts?: object) => { ok: boolean; errors?: { path: string; reason: string }[] };
  operationBudgets: (op: object) => { maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number; framing: string };
};
function regularFile(path: string, reason: string): Buffer {
  let st;
  try { st = lstatSync(path); } catch { throw new Refusal(`${reason}_missing`); }
  if (!st.isFile()) throw new Refusal(`${reason}_not_a_regular_file`);
  return readFileSync(path);
}
/**
 * P0-1's validator (never a second one). The module's and the schema file's sha256 must equal
 * mini-apps/manifests.pins.json, else Refusal (fail closed). The module is compiled from the very bytes
 * that were hashed (no require cache, no second read); it has no dependencies and no I/O by design.
 */
export function loadValidator(toolRoot: string): { validator: Validator; moduleSha: string } {
  const pinsBytes = regularFile(join(toolRoot, "mini-apps", "manifests.pins.json"), "pins");
  let pins: any;
  try { pins = JSON.parse(pinsBytes.toString("utf8")); } catch { throw new Refusal("pins_unparseable"); }
  const want = isObject(pins) ? pins.sha256 : null;
  if (!isObject(want) || !HEX64.test(String(want.module)) || !HEX64.test(String(want.schema))) throw new Refusal("pins_malformed");
  const source = regularFile(join(toolRoot, "scripts", "mini-apps-manifests.cjs"), "validator");
  const schema = regularFile(join(toolRoot, "mini-apps", "manifest.v2.schema.json"), "schema");
  const moduleSha = sha256(source);
  if (moduleSha !== want.module) throw new Refusal("validator_sha_mismatch");
  if (sha256(schema) !== want.schema) throw new Refusal("schema_sha_mismatch");
  const mod: { exports: any } = { exports: {} };
  try {
    new Function("module", "exports", source.toString("utf8"))(mod, mod.exports);
  } catch { throw new Refusal("validator_unloadable"); }
  const v = mod.exports;
  if (!v || v.MANIFEST_VERSION !== 2 || typeof v.validateManifest !== "function" || typeof v.operationBudgets !== "function") {
    throw new Refusal("validator_unexpected_exports");
  }
  return { validator: v as Validator, moduleSha };
}

// ---- Strict JSON: a raw-text scan, because JSON.parse keeps the last of two equal keys --------------
export type Pointer = string[];
export type StrictJson =
  | { ok: true; value: unknown; duplicates: { at: Pointer; key: string }[] }
  | { ok: false; error: string };
const MAX_DEPTH = 256;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
class JsonError extends Error {}
/**
 * RFC 8259 JSON, strictly: only space/tab/LF/CR between tokens (a BOM is refused), no raw control
 * character in a string, only the eight simple escapes and \uXXXX. Keys are compared after decoding, so
 * "a" and "a" are the same key, as they are to JSON.parse and to Python's json. Every object
 * (nested, or inside an array) is its own scope. The value is then JSON.parse's.
 */
export function strictJson(text: string): StrictJson {
  const duplicates: { at: Pointer; key: string }[] = [];
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const str = (): string => {
    i++; // the opening quote
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) throw new JsonError("unterminated_string");
      const c = text.charCodeAt(i);
      if (c === 0x22) { out += text.slice(start, i); i++; return out; }
      if (c < 0x20) throw new JsonError("control_character_in_string");
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        if (e !== undefined && own(SIMPLE_ESCAPES, e)) { out += SIMPLE_ESCAPES[e]; i += 2; }
        else if (e === "u" && HEX4.test(text.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
        else throw new JsonError("bad_escape");
        start = i;
        continue;
      }
      i++;
    }
  };
  const value = (at: Pointer, depth: number): void => {
    if (depth > MAX_DEPTH) throw new JsonError("too_deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const keys = new Set<string>();
      ws();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new JsonError("expected_key");
        const key = str();
        if (keys.has(key)) duplicates.push({ at, key });
        keys.add(key);
        ws();
        if (text[i] !== ":") throw new JsonError("expected_colon");
        i++;
        value([...at, key], depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        throw new JsonError("expected_comma_or_brace");
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") { i++; return; }
      for (let index = 0; ; index++) {
        value([...at, String(index)], depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        throw new JsonError("expected_comma_or_bracket");
      }
    }
    if (c === '"') { str(); return; }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) { i += word.length; return; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m || m[0] === "" ) throw new JsonError("unexpected_token");
    i += m[0].length;
  };
  try {
    value([], 0);
    ws();
    if (i !== n) throw new JsonError("trailing_data");
  } catch (e) {
    if (e instanceof JsonError) return { ok: false, error: e.message };
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "json_parse_disagrees" }; }
  return { ok: true, value: parsed, duplicates };
}
/** UTF-8 bytes to text, refusing invalid UTF-8 and keeping a BOM so strictJson refuses it. */
function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

// ---- Secret patterns (section 6.1's list; the validator's own scan, which covers manifests, is not exported)
/**
 * Over every key and string of a fixture after decoding (so an escaped secret is still found). Kept
 * aligned with FORBIDDEN_TEXT in scripts/mini-apps-manifests.cjs, plus the response-side shapes: bearer
 * values, the bridge's own avb_ token, AWS secret assignments, Stripe/Google/npm keys, URL userinfo with a
 * password, Basic credentials. `password=` only (not `password:` as the validator also refuses), since
 * response prose says "Password: ...". An assignment pattern runs on to the end of its value, so redact()
 * removes the value too, not only the key. Every pattern is linear: no `\b` (or other zero-width start)
 * in front of an unbounded run that can then fail, which is quadratic on "eyJ-eyJ-..." (the JWT shape
 * uses a lookbehind instead; P0-1's pinned validator still has the `\b` form, a P0-1 fix).
 */
export const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["sk_key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["stripe_key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["github_token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,}/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["jwt", /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["pem_private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["aws_access_key_id", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/],
  ["aws_secret_assignment", /aws_?secret_?access_?key["']?\s*[=:]\s*(?:"[^"\n]*"?|'[^'\n]*'?|\S*)/i],
  ["password_assignment", /\b(?:pass(?:word|wd)|passphrase)\s*=\s*(?:"[^"\n]*"?|'[^'\n]*'?|\S*)/i],
  ["bearer_value", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["av_bridge_token", /\bavb_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}/],
  // A quoted value runs to its closing quote, spaces included (api_key="abcd efgh ijkl").
  ["token_assignment", /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|session[_-]?id)["']?\s*[=:]\s*(?:"[^"\n]{12,}"?|'[^'\n]{12,}'?|[A-Za-z0-9._~+/-]{12,})/i],
  // scheme://user:password@, the user possibly empty (redis://:pw@host); a URL without a password, or
  // host:port, does not match.
  ["url_userinfo", /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@/],
  // A Basic credential after an Authorization header name ("Basic subscription" alone is prose; a value
  // held by an "Authorization" key is caught by AUTH_HEADER_KEYS below).
  ["basic_auth", /authorization["']?\s*[=:]\s*["']?basic\s+[A-Za-z0-9+/]{8,}={0,2}/i],
];
/** A key that names a credential, holding a non-empty string, is a secret whatever the value looks like. */
const SECRET_KEY_NAMES = new Set(["password", "passwd", "secret", "clientsecret", "apikey", "accesstoken", "refreshtoken",
  "idtoken", "authtoken", "bearertoken", "sessiontoken", "privatekey", "awssecretaccesskey",
  "secretkey", "xapikey", "token", "apisecret", "setcookie", "cookie", "apitoken", "passphrase", "sessionid"]);
/** An Authorization header held as a key: its value is a credential when it names an auth scheme. */
const AUTH_HEADER_KEYS = new Set(["authorization", "proxyauthorization"]);
const AUTH_SCHEME_VALUE = /^\s*(?:basic|bearer|digest|negotiate|token|apikey)\s+\S{8,}/i;
export function secretPattern(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return name;
  return null;
}
const normalKey = (key: string) => key.toLowerCase().replace(/[-_]/g, "");
const secretKeyName = (key: string) => SECRET_KEY_NAMES.has(normalKey(key));
/** Findings as [pointer, pattern]; a pointer never carries a secret-shaped segment (see show()). */
export function secretFindings(value: unknown, at: Pointer = [], out: [Pointer, string][] = []): [Pointer, string][] {
  if (typeof value === "string") {
    const hit = secretPattern(value);
    if (hit) out.push([at, hit]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => secretFindings(item, [...at, String(index)], out));
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      const hit = secretPattern(key);
      if (hit) out.push([[...at, key], `${hit}, in a key`]);
      const v = value[key];
      if (secretKeyName(key) && typeof v === "string" && v.trim() !== "") out.push([[...at, key], "secret_key_name"]);
      else if (AUTH_HEADER_KEYS.has(normalKey(key)) && typeof v === "string" && AUTH_SCHEME_VALUE.test(v)) out.push([[...at, key], "authorization_header"]);
      secretFindings(v, [...at, key], out);
    }
  }
  return out;
}
/** A JSON pointer for a note: secret-shaped or long segments are never printed as they are. */
export function show(at: Pointer): string {
  if (!at.length) return "/";
  return at.map(seg => {
    if (secretPattern(seg)) return "/<redacted>";
    const safe = seg.replace(/~/g, "~0").replace(/\//g, "~1").replace(/[^\x20-\x7e]/g, "?");
    return "/" + (safe.length > 64 ? safe.slice(0, 61) + "..." : safe);
  }).join("");
}
const MAX_NOTE_CHARS = 4000;
/** C0 and C1 controls, DEL, and the two Unicode line separators (U+2028, U+2029). */
const NOTE_CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, "g");
/**
 * The last net over every note, whatever produced it: no secret-shaped run, no control or line-break
 * character (a file name or manifest string cannot forge a summary line), and a bounded length.
 */
export function redact(note: string): string {
  let out = note;
  for (const [, pattern] of SECRET_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags + "g"), "<redacted>");
  out = out.replace(NOTE_CONTROL, "?");
  return out.length > MAX_NOTE_CHARS ? out.slice(0, MAX_NOTE_CHARS - 3) + "..." : out;
}
/** A fixture's <op>/<name> for a note: each segment as show() prints it (secret-shaped ones redacted). */
const fixtureLabel = (...segments: string[]) => show(segments).slice(1);
const listNote = (items: string[]) => items.length <= MAX_NOTE_ITEMS ? items.join("; ")
  : `${items.slice(0, MAX_NOTE_ITEMS).join("; ")}; and ${items.length - MAX_NOTE_ITEMS} more`;

// ---- Error codes: the closed set ----------------------------------------------------------------------
/**
 * The codes the village-bridge plugin (plugins/village-bridge/__init__.py) maps from an app or service
 * error body today, each owned by its app: transport()'s Gold Stars and For Kicks codes, ZZZ_ERRORS and
 * SLOPFOLIO_ERRORS. An app that owns codes here may use only its own. Every other app (a new one, and
 * Dizko, which owns none) uses GENERIC_ERROR_CODES, a documented list that is a CHOICE FOR THE LEAD: the
 * design's generic rule (section 2.2, `^[a-z][a-z0-9_]{0,63}$` with the app server's fixed instruction)
 * has no per-app code list in the manifest yet (Phase 1).
 */
export const BRIDGE_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  star_daily_limit: "gold-stars", star_already_sent: "gold-stars", star_self: "gold-stars",
  star_preview_expired: "gold-stars", star_preview_conflict: "gold-stars", star_confirmation_required: "gold-stars",
  star_cancelled: "gold-stars", star_approval_required: "gold-stars",
  forkicks_approval_required: "forkicks", forkicks_confirm_in_progress: "forkicks",
  DRAFT_NOT_EDITABLE: "slopfolio", DRAFT_NOT_FOUND: "slopfolio", CAPABILITY_NOT_GRANTED: "slopfolio", RATE_LIMITED: "slopfolio",
  zzz_not_connected: "zzzbot", zzz_reconnect_required: "zzzbot", zzz_rate_limited: "zzzbot",
  zzz_write_not_authorized: "zzzbot", zzz_not_found: "zzzbot", zzz_invalid: "zzzbot",
  connection_or_request_refused: "zzzbot", response_too_large: "zzzbot",
});
/** For Kicks' one parameterised code (transport(): a 409 on forkicks.order.confirm). */
const FORKICKS_PICKUP_ONLY = /^pickup_only:[A-Za-z0-9_-]{1,128}$/;
export const GENERIC_ERROR_CODES: readonly string[] = Object.freeze([
  "invalid_arguments", "not_found", "not_connected", "reconnect_required", "not_authorized",
  "rate_limited", "conflict", "expired", "in_progress", "unavailable",
]);
export function allowedErrorCode(appId: string, code: string): boolean {
  const owned = Object.keys(BRIDGE_ERROR_CODES).filter(c => BRIDGE_ERROR_CODES[c] === appId);
  if (!owned.length) return GENERIC_ERROR_CODES.includes(code);
  return owned.includes(code) || (appId === "forkicks" && FORKICKS_PICKUP_ONLY.test(code));
}
const MAX_DETAIL = 1000;

// ---- Version bump class (item 1) ---------------------------------------------------------------------
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/;
export type Bump = "downgrade" | "none" | "prerelease" | "patch" | "minor" | "major" | "invalid";
export function bumpOf(from: string, to: string): Bump {
  const a = SEMVER.exec(String(from)), b = SEMVER.exec(String(to));
  if (!a || !b) return "invalid";
  for (const [index, name] of [[1, "major"], [2, "minor"], [3, "patch"]] as const) {
    const x = Number(a[index]), y = Number(b[index]);
    if (y > x) return name;
    if (y < x) return "downgrade";
  }
  // Equal triples: semver precedence of the prerelease (1.0.0-rc.1 < 1.0.0, rc.2 < rc.10, 1 < alpha).
  const order = prereleaseOrder(a[4], b[4]);
  return order === 0 ? "none" : order > 0 ? "prerelease" : "downgrade";
}
/** Semver section 11: > 0 when `to` is the higher prerelease, < 0 when lower, 0 when of equal precedence. */
function prereleaseOrder(from: string | undefined, to: string | undefined): number {
  if (from === to) return 0;
  if (from === undefined) return -1; // 1.0.0 -> 1.0.0-x goes down
  if (to === undefined) return 1;    // 1.0.0-x -> 1.0.0 goes up
  const x = from.split("."), y = to.split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === q) continue;
    const pn = /^[0-9]+$/.test(p), qn = /^[0-9]+$/.test(q);
    if (pn && qn) {
      const d = BigInt(q) - BigInt(p);
      if (d !== 0n) return d > 0n ? 1 : -1;
      continue;
    }
    if (pn !== qn) return pn ? 1 : -1; // a numeric identifier is lower than an alphanumeric one
    return q > p ? 1 : -1;             // ASCII order
  }
  return y.length - x.length;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/**
 * An input schema without its annotation keywords (description, title, examples, $comment), removed only
 * where a keyword stands: in a schema object, and in the subschemas of the keywords below. A property
 * NAMED "description" (a key of `properties`) is kept, and so is anything under a keyword not listed, so
 * an edit there still counts as a change.
 */
const ANNOTATIONS = new Set(["description", "title", "examples", "$comment"]);
const SCHEMA_MAP = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_ONE = new Set(["additionalProperties", "items", "additionalItems", "contains", "propertyNames", "not", "if", "then",
  "else", "unevaluatedItems", "unevaluatedProperties"]);
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
export function withoutAnnotations(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA_MAP.has(key) && isObject(v)) out[key] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, withoutAnnotations(sub)]));
    else if (SCHEMA_ONE.has(key)) out[key] = Array.isArray(v) ? v.map(withoutAnnotations) : withoutAnnotations(v);
    else if (SCHEMA_LIST.has(key) && Array.isArray(v)) out[key] = v.map(withoutAnnotations);
    else out[key] = v;
  }
  return out;
}
/**
 * A reference can point INTO an annotation (`{$ref: "#/examples/0"}`, `#/$defs/x/description`), and then an
 * "annotation" edit changes what is enforced. So the annotation-only patch holds only when neither input
 * has a reference, or when every reference (any depth, any position) is exactly `#/$defs/<name>` to a def
 * at the input's root that both inputs hold and that is unchanged beyond annotations, and neither input has
 * an `$id` (which moves what `#` names). Anything else is major.
 */
const REF_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const LOCAL_DEF_REF = /^#\/\$defs\/[A-Za-z0-9_-]+$/;
function refsOf(value: unknown, out: { refs: unknown[]; ids: boolean } = { refs: [], ids: false }) {
  if (Array.isArray(value)) for (const item of value) refsOf(item, out);
  else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (REF_KEYS.has(key)) out.refs.push(v);
      if (key === "$id") out.ids = true;
      refsOf(v, out);
    }
  }
  return out;
}
export function annotationOnlyEdit(from: unknown, to: unknown): boolean {
  if (!same(withoutAnnotations(from), withoutAnnotations(to))) return false;
  const a = refsOf(from), b = refsOf(to);
  if (!a.refs.length && !b.refs.length) return true;
  if (a.ids || b.ids) return false;
  const defs = (schema: unknown) => isObject(schema) && isObject(schema.$defs) ? schema.$defs : null;
  const x = defs(from), y = defs(to);
  return [...a.refs, ...b.refs].every(ref => {
    if (typeof ref !== "string" || !LOCAL_DEF_REF.test(ref)) return false;
    const name = ref.slice("#/$defs/".length);
    return !!x && !!y && own(x, name) && own(y, name) && same(withoutAnnotations(x[name]), withoutAnnotations(y[name]));
  });
}
const CEILING_RANK: Record<string, number> = { private: 0, village: 1, public: 2 };
type Level = "patch" | "major" | "refuse";
/**
 * What a change from `from` to `to` (two valid v2 manifests) needs. Major (design section 1.1): an op
 * added, or widened (class, target, input, a budget raised, framing, returns widened, any approval
 * change: the summary template), any service change (auth, kind, baseUrl), data added or widened,
 * events added or changed, legacy or owner changed. v0 cannot prove an input schema tighter, so any
 * input change is major, except an edit of annotations only (description, title, examples, $comment:
 * withoutAnnotations()) with no reference that could point into one (annotationOnlyEdit()), which is a patch. Everything else that changed (copy, permissions, skills,
 * visibility, an op removed, a budget lowered) needs at least a patch. A changed id is refused.
 */
export function requiredBump(from: any, to: any, budgets: Validator["operationBudgets"]): { level: Level | "none"; reasons: string[] } {
  const reasons: [Level, string][] = [];
  const add = (level: Level, text: string) => reasons.push([level, text]);
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(k => k !== "version").sort();
  for (const key of keys) {
    if (same(from[key], to[key])) continue;
    if (key === "id") add("refuse", "id changed (ids are immutable)");
    else if (key === "operations") operationChanges(from.operations || [], to.operations || [], add, budgets);
    else if (key === "service") {
      for (const sub of [...new Set([...Object.keys(from.service || {}), ...Object.keys(to.service || {})])].sort()) {
        if (!same(from.service?.[sub], to.service?.[sub])) add("major", `service.${sub} changed`);
      }
    } else if (key === "data") dataChanges(from.data, to.data, add);
    else if (key === "events") {
      const a = from.events || {}, b = to.events || {};
      for (const name of Object.keys(b)) if (!own(a, name) || !same(a[name], b[name])) add("major", `event ${name} added or changed`);
      for (const name of Object.keys(a)) if (!own(b, name)) add("patch", `event ${name} removed`);
    } else if (key === "legacy" || key === "owner" || key === "manifest") add("major", `${key} changed`);
    else add("patch", `${key} changed`);
  }
  const level = reasons.some(([l]) => l === "refuse") ? "refuse" : reasons.some(([l]) => l === "major") ? "major" : reasons.length ? "patch" : "none";
  const order = { refuse: 0, major: 1, patch: 2 };
  return { level, reasons: reasons.sort((x, y) => order[x[0]] - order[y[0]]).map(([l, t]) => `${l}: ${t}`) };
}
function operationChanges(from: any[], to: any[], add: (l: Level, t: string) => void, budgets: Validator["operationBudgets"]) {
  const a = new Map(from.map(op => [op.name, op])), b = new Map(to.map(op => [op.name, op]));
  for (const [name, op] of b) {
    const old = a.get(name);
    if (!old) { add("major", `operation ${name} added`); continue; }
    if (old.class !== op.class) add("major", `${name} class ${old.class} -> ${op.class}`);
    if (!same(old.target, op.target)) add("major", `${name} target changed`);
    if (!same(old.input, op.input)) {
      if (annotationOnlyEdit(old.input, op.input)) add("patch", `${name} input annotations changed`);
      else add("major", `${name} input changed`);
    }
    const x = budgets(old), y = budgets(op);
    for (const field of ["maxRequestBytes", "maxResponseBytes", "timeoutMs"] as const) {
      if (y[field] > x[field]) add("major", `${name} ${field} raised ${x[field]} -> ${y[field]}`);
      else if (y[field] < x[field]) add("patch", `${name} ${field} lowered`);
    }
    if (x.framing !== y.framing) add("major", `${name} framing ${x.framing} -> ${y.framing}`);
    if (!same(old.returns, op.returns)) {
      const r = old.returns, s = op.returns;
      if (!r || !s || r.draftIdPath !== s.draftIdPath || r.previewPath !== s.previewPath) add("major", `${name} returns changed`);
      for (const field of ["previewMaxBytes", "previewTtlSeconds"]) {
        if (r && s && s[field] > r[field]) add("major", `${name} returns.${field} raised`);
        else if (r && s && s[field] < r[field]) add("patch", `${name} returns.${field} lowered`);
      }
    }
    if (!same(old.approval, op.approval)) add("major", `${name} approval changed (prepare, summary template or summaryMaxBytes)`);
  }
  for (const name of a.keys()) if (!b.has(name)) add("patch", `operation ${name} removed`);
  const common = (list: any[], other: Map<string, any>) => list.map(op => op.name).filter(n => other.has(n));
  if (!same(common(from, b), common(to, a))) add("patch", "operations reordered");
}
function dataChanges(from: any, to: any, add: (l: Level, t: string) => void) {
  const a = from?.context, b = to?.context;
  if (!a && b) add("major", "data.context added");
  else if (a && !b) add("patch", "data.context removed");
  else if (a && b) {
    if (b.maxEntries > a.maxEntries) add("major", `data.context.maxEntries raised ${a.maxEntries} -> ${b.maxEntries}`);
    else if (b.maxEntries < a.maxEntries) add("patch", "data.context.maxEntries lowered");
    const x = CEILING_RANK[a.ceiling || "private"], y = CEILING_RANK[b.ceiling || "private"];
    if (y > x) add("major", `data.context.ceiling widened ${a.ceiling || "private"} -> ${b.ceiling}`);
    else if (y < x) add("patch", "data.context.ceiling narrowed");
  }
  const rest = (d: any) => isObject(d) ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "context")) : {};
  if (!same(rest(from), rest(to))) add("major", "data changed beyond data.context");
}
export function bumpVerdict(required: { level: Level | "none"; reasons: string[] }, from: string, to: string): Result {
  const actual = bumpOf(from, to);
  const why = required.reasons.length ? ` (${listNote(required.reasons)})` : "";
  const got = `${from} -> ${to} is ${actual}`;
  if (required.level === "refuse") return fail("version.bump", `refused${why}`);
  if (actual === "invalid" || actual === "downgrade") return fail("version.bump", `${got}${why}`);
  if (required.level === "major" && actual !== "major") return fail("version.bump", `needs a major bump, ${got}${why}`);
  if (required.level === "patch" && actual === "none") return fail("version.bump", `the manifest changed but the version did not${why}`);
  return pass("version.bump", required.level === "none" ? `no change since the base; ${got}` : `needs ${required.level}, ${got}${why}`);
}

// ---- git, local only (--base) -----------------------------------------------------------------------
const BASE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^+-]{0,254}$/;
function git(cwd: string, args: string[]): { status: number | null; stdout: Buffer } {
  const r = spawnSync("git", args, {
    cwd, maxBuffer: 16 << 20,
    // Local reads only: never prompt, never fetch a missing object of a partial clone, take no lock.
    // A path is a literal path, never a glob pathspec.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0) };
}
type Base = { ref: string; commit: string; blob: Buffer | null };
/** The argument half of --base: the ref's syntax, a git checkout holding the manifest, a commit it names. */
function baseCommit(root: string, manifestAbs: string, ref: string): { rel: string; sha: string } {
  if (!BASE_REF.test(ref) || ref.includes("..")) throw new Refusal("bad_base_ref");
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Refusal("base_needs_a_git_checkout");
  const rel = relative(realpathSync(top.stdout.toString("utf8").trim()), realpathSync(manifestAbs)).split(sep).join("/");
  if (rel.startsWith("../") || rel === "..") throw new Refusal("manifest_outside_the_git_checkout");
  const commit = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (commit.status !== 0) throw new Refusal("base_ref_unknown");
  return { rel, sha: commit.stdout.toString("utf8").trim() };
}
function resolveBase(root: string, manifestAbs: string, ref: string): Base {
  const { rel, sha } = baseCommit(root, manifestAbs, ref);
  // The base tree decides "absent" (a new app): `cat-file -e <sha>:<path>` cannot tell an absent path
  // from a present blob that is not local (a --filter=blob:none clone with lazy fetch off), and that
  // must never pass as a new manifest. An unreadable tree (a --filter=tree:0 clone) refuses too.
  const listed = git(root, ["ls-tree", "-z", "--full-tree", sha, "--", rel]);
  if (listed.status !== 0) throw new Refusal("base_tree_unreadable");
  const entry = listed.stdout.toString("utf8");
  if (entry === "") return { ref, commit: sha, blob: null };
  const m = /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]*)\0$/.exec(entry);
  if (!m || m[4] !== rel) throw new Refusal("base_tree_unreadable");
  if (m[2] !== "blob" || m[1] === "120000") throw new Refusal("base_manifest_not_a_regular_file");
  const oid = m[3];
  if (git(root, ["cat-file", "-e", oid]).status !== 0) throw new Refusal("base_blob_missing");
  const blob = git(root, ["cat-file", "blob", oid]);
  if (blob.status !== 0) throw new Refusal("base_blob_missing");
  return { ref, commit: sha, blob: blob.stdout };
}

// ---- The run -------------------------------------------------------------------------------------------
export type Options = { manifest: string; fixtures?: string; base?: string; out?: string };
type Located = { abs: string; root: string; dirId: string; rel: string };
function locate(manifestArg: string, cwd: string): Located {
  const abs = resolve(cwd, manifestArg);
  const appDir = dirname(abs), miniApps = dirname(appDir);
  if (basename(abs) !== "manifest.json" || basename(miniApps) !== "mini-apps") throw new Refusal("manifest_path_must_be_mini-apps/<id>/manifest.json");
  let st;
  try { st = lstatSync(abs); } catch { throw new Refusal("manifest_missing"); }
  if (!st.isFile()) throw new Refusal("manifest_not_a_regular_file");
  const dirId = basename(appDir);
  return { abs, root: dirname(miniApps), dirId, rel: `mini-apps/${dirId}/manifest.json` };
}
function directory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Runs every check. Throws Refusal for bad arguments or a validator pin mismatch (exit 2). */
export function runConformance(opts: Options, { cwd = process.cwd(), toolRoot = resolve(import.meta.dir, "..") } = {}): Report {
  const { validator } = loadValidator(toolRoot);
  const at = locate(opts.manifest, cwd);
  const base = opts.base !== undefined ? resolveBase(at.root, at.abs, opts.base) : null;
  let fixtures: string | null = null;
  let fixturesNote = "";
  if (opts.fixtures !== undefined) {
    fixtures = resolve(cwd, opts.fixtures);
    if (!directory(fixtures)) throw new Refusal("fixtures_not_a_directory");
  } else {
    const fallback = join(dirname(at.abs), "fixtures");
    if (exists(fallback)) fixtures = fallback;
    else fixturesNote = `no fixtures: pass --fixtures <dir> (${at.rel.replace(/manifest\.json$/, "fixtures/")} is absent)`;
  }

  const bytes = readFileSync(at.abs);
  const results: Result[] = [pass("manifest.validator_pin", "scripts/mini-apps-manifests.cjs and mini-apps/manifest.v2.schema.json match mini-apps/manifests.pins.json")];
  // Item 1: the manifest itself.
  let manifest: any = null;
  let valid = false;
  const text = bytes.length <= MAX_MANIFEST_BYTES ? utf8(bytes) : null;
  const strict = text === null ? null : strictJson(text);
  if (bytes.length > MAX_MANIFEST_BYTES) results.push(fail("manifest.schema", `over ${MAX_MANIFEST_BYTES} bytes`));
  else if (text === null) results.push(fail("manifest.schema", "not UTF-8"));
  else if (!strict!.ok) results.push(fail("manifest.schema", `not strict JSON: ${(strict as { error: string }).error}`));
  else {
    manifest = strict!.value;
    const problems: string[] = (strict as { duplicates: { at: Pointer; key: string }[] }).duplicates.map(d => `duplicate key ${show([...d.at, d.key])}`);
    const checked = validator.validateManifest(manifest);
    if (!checked.ok) problems.push(...(checked.errors || []).map(e => `${e.path} ${e.reason}`));
    if (isObject(manifest) && manifest.id !== at.dirId) problems.push(`/id is not its directory name (mini-apps/${at.dirId}/)`);
    valid = problems.length === 0;
    results.push(valid
      ? pass("manifest.schema", "a valid v2 manifest by the shared validator (input schemas are compiled by the cp's ajv at load, not here)")
      : fail("manifest.schema", listNote(problems)));
  }
  results.push(skillHashes(manifest, at.root));
  results.push(versionBump(base, manifest, valid, validator));
  // Items 2-3 and the fake-cp half of item 4: Phase 1.
  results.push(notRun("service.reachability", "Phase 1 (conformance v1): initialize/tools/list, https-json paths, oauth discovery"));
  results.push(notRun("service.budgets", "Phase 1 (conformance v1): read ops within timeoutMs and maxResponseBytes against a live service"));
  results.push(preparePairs(manifest));
  results.push(summaryRender(manifest));
  results.push(notRun("approval.fake_cp", "Phase 1: wrong draftId, changed hash and no grant refused by a fake cp; two confirms of one draftId make one target call"));
  // Item 5.
  results.push(...hygiene(fixtures, fixturesNote, manifest, validator));
  for (const r of results) r.note = redact(r.note);
  return { manifest: at.rel, sha256: sha256(bytes), results, passed: passedOf(results) };
}

function skillHashes(manifest: any, root: string): Result {
  if (!isObject(manifest)) return notRun("skills.sha256", "the manifest is not readable JSON");
  const skills = manifest.skills;
  if (!Array.isArray(skills) || !skills.length) return fail("skills.sha256", "no skills[] to check");
  const problems: string[] = [], ok: string[] = [];
  skills.forEach((skill: any, index: number) => {
    const path = skill?.path;
    if (typeof path !== "string" || !/^skills\/[a-z][a-z0-9-]{0,63}\/SKILL\.md$/.test(path) || typeof skill.sha256 !== "string") {
      problems.push(`skills[${index}] has no checkable path and sha256`);
      return;
    }
    const abs = join(root, ...path.split("/"));
    let st;
    try { st = lstatSync(abs); } catch { problems.push(`${path} missing`); return; }
    if (!st.isFile()) { problems.push(`${path} is not a regular file`); return; }
    try {
      const real = realpathSync(abs);
      if (relative(realpathSync(root), real).split(sep)[0] === "..") { problems.push(`${path} resolves outside the repo`); return; }
    } catch { problems.push(`${path} unresolvable`); return; }
    const actual = sha256(readFileSync(abs));
    if (actual !== skill.sha256) problems.push(`${path} sha256 is ${actual}, the manifest says ${show([skill.sha256]).slice(1)}`);
    else ok.push(path);
  });
  return problems.length ? fail("skills.sha256", listNote(problems)) : pass("skills.sha256", `matches: ${ok.join(", ")}`);
}

function versionBump(base: Base | null, manifest: any, valid: boolean, validator: Validator): Result {
  if (!base) return notRun("version.bump", "no --base: the bump class needs a base ref to diff against");
  if (!valid) return notRun("version.bump", "the manifest is not a valid v2 manifest");
  if (!base.blob) return pass("version.bump", `a new manifest: none at ${base.ref} (${base.commit.slice(0, 12)})`);
  const text = utf8(base.blob);
  const strict = text === null ? null : strictJson(text);
  const old = strict?.ok ? strict.value : null;
  if (!isObject(old) || old.manifest !== 2) return notRun("version.bump", `the manifest at ${base.ref} is not v2: a v1 -> v2 conversion has no bump class`);
  if (!validator.validateManifest(old).ok) return notRun("version.bump", `the manifest at ${base.ref} is not a valid v2 manifest`);
  return bumpVerdict(requiredBump(old, manifest, validator.operationBudgets), old.version, manifest.version);
}

function opsOf(manifest: any): any[] {
  return isObject(manifest) && Array.isArray(manifest.operations) ? manifest.operations.filter(isObject) : [];
}
function preparePairs(manifest: any): Result {
  if (!isObject(manifest)) return notRun("approval.prepare_pair", "the manifest is not readable JSON");
  const ops = opsOf(manifest);
  const cards = ops.filter(op => op.class === "needs-card");
  if (!cards.length) return pass("approval.prepare_pair", "no needs-card operation");
  const problems: string[] = [];
  for (const op of cards) {
    const name = op.approval?.prepare;
    const prepare = ops.find(o => o.name === name);
    if (typeof name !== "string") problems.push(`${op.name}: no approval.prepare`);
    else if (!prepare) problems.push(`${op.name}: approval.prepare ${name} is not an operation of this manifest`);
    else if (prepare.class !== "prepare") problems.push(`${op.name}: approval.prepare ${name} is class ${prepare.class}, not prepare`);
  }
  return problems.length ? fail("approval.prepare_pair", listNote(problems))
    : pass("approval.prepare_pair", cards.map(op => `${op.name} <- ${op.approval.prepare}`).join("; "));
}
function summaryRender(manifest: any): Result {
  const cards = opsOf(manifest).filter(op => op.class === "needs-card");
  const which = cards.length
    ? `; needs-card ops: ${cards.map(op => `${op.name} (${Array.isArray(op.approval?.summary) ? "has" : "no"} summary template)`).join(", ")}`
    : "; no needs-card op";
  return notRun("approval.summary_render",
    "renderer_absent: no section 3.2 summary-template renderer exists in this repo in Node or Python yet " +
    "(P0-1: the For Kicks card cannot be expressed in the section 3.2 grammar; Phase 1 item 6). v0 does not render" + which);
}

type Fixture = { label: string; op: string; error: boolean; bytes: Buffer };
function hygiene(dir: string | null, absentNote: string, manifest: any, validator: Validator): Result[] {
  const names = ["hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies"];
  if (!dir) return names.map(check => notRun(check, absentNote));
  const ops = new Map(opsOf(manifest).filter(op => typeof op.name === "string").map(op => [op.name as string, op]));
  const layout: string[] = [];
  const files: Fixture[] = [];
  if (!directory(dir)) layout.push("the fixture path is not a directory (a symlink is refused)");
  else {
    for (const entry of readdirSync(dir).sort()) {
      const st = lstatSync(join(dir, entry));
      const shown = fixtureLabel(entry);
      if (st.isSymbolicLink()) { layout.push(`${shown}: symlink`); continue; }
      if (!st.isDirectory()) { layout.push(`${shown}: a fixture sits in an <operation>/ directory`); continue; }
      const op = ops.get(entry);
      if (!op) { layout.push(`${shown}/: not an operation of this manifest`); continue; }
      const limit = validator.operationBudgets(op).maxResponseBytes;
      for (const name of readdirSync(join(dir, entry)).sort()) {
        const label = fixtureLabel(entry, name);
        const fst = lstatSync(join(dir, entry, name));
        if (fst.isSymbolicLink()) layout.push(`${label}: symlink`);
        else if (!fst.isFile()) layout.push(`${label}: not a regular file`);
        else if (!name.endsWith(".json")) layout.push(`${label}: not a .json file`);
        else if (fst.size > limit) layout.push(`${label}: ${fst.size} bytes is over ${shown}'s maxResponseBytes ${limit} (the reader refuses it)`);
        else if (files.length >= MAX_FIXTURE_FILES) { layout.push(`more than ${MAX_FIXTURE_FILES} fixture files`); break; }
        else files.push({ label, op: entry, error: name.startsWith("error"), bytes: readFileSync(join(dir, entry, name)) });
      }
    }
  }
  const out: Result[] = [];
  if (layout.length) out.push(fail("hygiene.fixtures", listNote(layout)));
  else if (!files.length) out.push(notRun("hygiene.fixtures", "the fixture directory holds no fixture file"));
  else out.push(pass("hygiene.fixtures", `${files.length} fixture file(s), ${files.filter(f => f.error).length} error bod(ies)`));
  if (!files.length) return [...out, ...names.slice(1).map(check => notRun(check, "no fixture file to read"))];

  const secrets: string[] = [], strictness: string[] = [], bodies: string[] = [];
  const appId = isObject(manifest) && typeof manifest.id === "string" ? manifest.id : "";
  let errorCount = 0;
  for (const f of files) {
    const text = utf8(f.bytes);
    const parsed = text === null ? null : strictJson(text);
    if (text === null) strictness.push(`${f.label}: not UTF-8`);
    else if (!parsed!.ok) strictness.push(`${f.label}: not strict JSON (${(parsed as { error: string }).error})`);
    else for (const d of (parsed as { duplicates: { at: Pointer; key: string }[] }).duplicates) strictness.push(`${f.label}: duplicate key ${show([...d.at, d.key])}`);
    if (parsed?.ok) {
      for (const [where, pattern] of secretFindings(parsed.value)) secrets.push(`${f.label} ${show(where)} (${pattern})`);
    } else {
      // An unparseable file is still scanned, as raw text.
      const hit = secretPattern(text ?? f.bytes.toString("latin1"));
      if (hit) secrets.push(`${f.label} raw text (${hit})`);
    }
    if (!parsed?.ok) continue;
    const body = parsed.value;
    if (f.error) {
      errorCount++;
      if (!isObject(body)) { bodies.push(`${f.label}: an error body is a {code, detail} object`); continue; }
      const keys = Object.keys(body).sort();
      if (keys.join(",") !== "code,detail") bodies.push(`${f.label}: keys are ${show(keys).slice(1).split("/").join(", ") || "none"}, not exactly code, detail`);
      if (typeof body.code !== "string" || !allowedErrorCode(appId, body.code)) {
        const owner = typeof body.code === "string" ? BRIDGE_ERROR_CODES[body.code] : undefined;
        bodies.push(`${f.label}: code ${typeof body.code === "string" ? show([body.code]).slice(1) : "(not a string)"} is not in the closed set for ${appId || "this app"}${owner && owner !== appId ? ` (it is ${owner}'s)` : ""}`);
      }
      if (own(body, "detail") && (typeof body.detail !== "string" || body.detail.trim() === "" || [...body.detail].length > MAX_DETAIL)) {
        bodies.push(`${f.label}: detail is a non-empty string of at most ${MAX_DETAIL} characters`);
      }
    } else if (isObject(body) && own(body, "error")) {
      bodies.push(`${f.label}: a success fixture carries "error"; an error body belongs in an error*.json fixture as {code, detail}`);
    }
  }
  out.push(secrets.length ? fail("hygiene.secrets", listNote(secrets)) : pass("hygiene.secrets", `no secret pattern in ${files.length} fixture file(s)`));
  out.push(strictness.length ? fail("hygiene.duplicate_keys", listNote(strictness)) : pass("hygiene.duplicate_keys", `${files.length} fixture file(s) strict JSON, no duplicate key`));
  if (bodies.length) out.push(fail("hygiene.error_bodies", listNote(bodies)));
  else if (!errorCount) out.push(notRun("hygiene.error_bodies", "no error fixture: add <operation>/error*.json with the service's {code, detail} body"));
  else out.push(pass("hygiene.error_bodies", `${errorCount} error bod(ies) are {code, detail} with a closed code`));
  return out;
}

// ---- CLI -----------------------------------------------------------------------------------------------
export const USAGE = "usage: bun run conformance -- mini-apps/<id>/manifest.json [--fixtures <dir>] [--out <path>] [--base <git ref>]";
export function parseArgs(argv: string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fixtures" || a === "--out" || a === "--base") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--") || value === "") throw new Refusal(`${a}_needs_a_value`);
      if (own(flags, a)) throw new Refusal(`${a}_given_twice`);
      flags[a] = value;
    } else if (a.startsWith("-")) throw new Refusal(`unknown_option ${a.slice(0, 40)}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Refusal("one_manifest_path_expected");
  return { manifest: positional[0], fixtures: flags["--fixtures"], out: flags["--out"], base: flags["--base"] };
}
export function summary(report: Report): string {
  const label = (r: Result) => r.pass === true ? "PASS   " : r.pass === false ? "FAIL   " : "NOT RUN";
  // The path comes from a directory name: printed through show(), so a newline in it cannot forge a line.
  return [`conformance ${show(report.manifest.split("/")).slice(1)} sha256 ${show([report.sha256]).slice(1)}`,
    ...report.results.map(r => `  ${label(r)} ${r.check}: ${r.note}`),
    `passed: ${report.passed}`].join("\n");
}
/** Written to a temp file beside `path` (wx: never through a planted file or symlink), then renamed. */
function writeOut(path: string, report: Report) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  try { renameSync(tmp, path); } catch (e) { removeFile(tmp); throw e; }
}
/** Unlinks a file or symlink (never its target, never a directory); an absent path is fine. */
function removeFile(path: string) {
  try { unlinkSync(path); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
}
const inode = (path: string): string | null => {
  try { const st = statSync(path); return `${st.dev}:${st.ino}`; } catch { return null; }
};
/** The git checkout holding `dir`, if any (one more "repo" --out may not point into). */
function gitTop(dir: string): string | null {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top.status === 0 ? top.stdout.toString("utf8").trim() || null : null;
}
/**
 * The --out file, resolved, or Refusal (release ruling, CLAIMS L14545). It may not be the manifest (the
 * same dev+ino: a hard link or a symlink to it too), a directory, or anywhere inside the manifest's repo
 * (the directory holding its mini-apps/, and the git checkout around it) or the tool's own root: every
 * ancestor of its real parent is compared by dev+ino with each, and on a case-insensitive filesystem the
 * case-folded real path is compared as well (macOS: MINI-APPS/acme/x.json is under the repo).
 */
export function outPath(outArg: string, manifestArg: string, cwd: string, toolRoot: string): string {
  const out = resolve(cwd, outArg);
  let parent: string;
  try {
    if (!statSync(dirname(out)).isDirectory()) throw new Error();
    parent = realpathSync(dirname(out));
  } catch { throw new Refusal("out_directory_missing"); }
  const real = join(parent, basename(out));
  if (directory(out) || directory(real)) throw new Refusal("out_is_a_directory");
  const manifest = resolve(cwd, manifestArg);
  const manifestId = inode(manifest);
  if (manifestId !== null && (inode(out) === manifestId || inode(real) === manifestId)) throw new Refusal("out_would_overwrite_the_manifest");
  const guards = [toolRoot];
  if (basename(dirname(dirname(manifest))) === "mini-apps") {
    const repo = dirname(dirname(dirname(manifest)));
    guards.push(repo);
    const top = directory(repo) ? gitTop(repo) : null;
    if (top) guards.push(top);
  }
  const unsafe = "out_inside_the_repo_or_the_tool_root";
  for (const guarded of new Set(guards)) {
    const guardedId = inode(guarded);
    if (guardedId === null) continue;
    for (let p = parent; ; p = dirname(p)) {
      if (inode(p) === guardedId) throw new Refusal(unsafe);
      if (dirname(p) === p) break;
    }
    if (caseInsensitive(guarded)) {
      const fold = (path: string) => path.normalize("NFC").toLowerCase();
      const g = fold(realpathSync(guarded)), o = fold(real);
      if (o === g || o.startsWith(g + sep)) throw new Refusal(unsafe);
    }
  }
  return out;
}
/** Whether the filesystem holding `dir` folds case: its own name upper-cased names the same directory. */
function caseInsensitive(dir: string): boolean {
  const name = basename(dir), flipped = name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase();
  if (flipped === name) return false;
  const id = inode(dir);
  return id !== null && inode(join(dirname(dir), flipped)) === id;
}
const MAX_REPORT_BYTES = 1 << 20;
/**
 * Whether `path` holds a conformance.json for THIS manifest (`rel`): a regular file (not a symlink) of
 * strict JSON shaped {manifest, sha256, results, passed} whose manifest is `rel`. Only such a file is
 * ever removed or replaced; anything else at --out is refused before the run and left as it is.
 */
export function ownReport(path: string, rel: string): boolean {
  let st;
  try { st = lstatSync(path); } catch { return false; }
  if (!st.isFile() || st.size > MAX_REPORT_BYTES) return false;
  let text: string | null;
  try { text = utf8(readFileSync(path)); } catch { return false; }
  const parsed = text === null ? null : strictJson(text);
  if (!parsed?.ok || parsed.duplicates.length) return false;
  const r = parsed.value;
  return isObject(r) && Object.keys(r).sort().join(",") === "manifest,passed,results,sha256" && r.manifest === rel
    && typeof r.sha256 === "string" && HEX64.test(r.sha256) && typeof r.passed === "boolean" && Array.isArray(r.results)
    && r.results.every((x: unknown) => isObject(x) && Object.keys(x).sort().join(",") === "check,note,pass");
}
/**
 * The CLI: returns the exit code (0 passed, 1 failed, 2 refused). Every argument (the options, the
 * manifest path, --fixtures, the --base ref, --out) is checked before any file is touched, so an
 * argument refusal changes nothing on disk. A file already at --out must be this manifest's own
 * conformance.json (else that is an argument refusal too); it is removed before the run, and the new one
 * is renamed into place only for exit 0 or 1. On any later refusal only a file that parses as this
 * manifest's conformance.json is removed.
 */
export function main(argv: string[], { cwd = process.cwd(), toolRoot = resolve(import.meta.dir, ".."), print = console.log, warn = console.error } = {}): number {
  let out: string | null = null;
  let rel = "";
  try {
    const opts = parseArgs(argv);
    const at = locate(opts.manifest, cwd);
    if (opts.fixtures !== undefined && !directory(resolve(cwd, opts.fixtures))) throw new Refusal("fixtures_not_a_directory");
    if (opts.base !== undefined) baseCommit(at.root, at.abs, opts.base);
    if (opts.out !== undefined) {
      const path = outPath(opts.out, opts.manifest, cwd, toolRoot);
      if (exists(path) && !ownReport(path, at.rel)) throw new Refusal("out_exists_and_is_not_this_manifests_conformance_json");
      out = path;
      rel = at.rel;
      removeFile(out);
    }
    const report = runConformance(opts, { cwd, toolRoot });
    const text = summary(report);
    if (out) writeOut(out, report);
    print(text);
    return report.passed ? 0 : 1;
  } catch (e) {
    if (out && ownReport(out, rel)) { try { removeFile(out); } catch { /* the refusal below stands */ } }
    if (e instanceof Refusal) { warn(`conformance: refused: ${e.reason}\n${USAGE}`); return 2; }
    warn(`conformance: refused: internal error ${e instanceof Error ? e.name : "unknown"}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

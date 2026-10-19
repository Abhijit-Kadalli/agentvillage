/**
 * Mini-apps manifest v2: the JSON Schema and the ONE validator (MINIAPPS-PLATFORM-v2-design.md §1.1, §1.3,
 * §8 Phase 0 item 1). One JSON document per app is its whole definition; this module decides whether a
 * document is one, and derives from it the v1 catalog entry the cp serves today (byte for byte), so the
 * five reviewed constants can be served from five manifests.
 *
 * This file is byte-identical in three repos (each pins its sha256 twice: a pins file and its test):
 *   agentvillage-controlplane  control-plane/src/mini-apps-manifests.js
 *   agentvillage-app           src/lib/server/mini-apps/manifests/mini-apps-manifests.cjs
 *   agentvillage (overlay)     scripts/mini-apps-manifests.cjs
 * Change all three together. CommonJS, no dependencies and no I/O: a caller reads the files, this decides.
 * The schema is interpreted here (the subset of JSON Schema 2020-12 it uses: type, const, enum, pattern,
 * lengths, bounds, items, properties, required, additionalProperties, propertyNames, anyOf, $ref), so the
 * same bytes give the same answer in Node, Bun and the app; the cp and app tests check that ajv 2020
 * (strict) gives the same answer as this interpreter on every manifest they try.
 *
 * Phase 0 (dark): nothing reads a manifest at runtime unless the cp's MINI_APPS_MANIFESTS=1 is set. The
 * `legacy` block carries what today's exact-equality v1 entry needs and v2 does not model (provenance,
 * the per-box person entry, the op prefixes that predate "first segment = id"); it retires with the
 * signed projection (design §1.2, §2.3, Phase 2).
 */
'use strict';

const MANIFEST_VERSION = 2;
const CODE = 'mini_apps_manifest_invalid';
const V1_CODE = 'mini_apps_manifest_v1_unrepresentable';
const MAX_ERRORS = 32;
// The cp's app id rule (cp-events.js CLAIM_APP_ID; the app's sections.ts APP_ID): one rule everywhere.
const APP_ID = '^[a-z0-9][a-z0-9-]{0,39}$';
// Two to four dot-separated segments; `_` is allowed because today's names use it (zzz.list_rooms).
const OPERATION_NAME = '^[a-z0-9][a-z0-9_-]*(\\.[a-z0-9][a-z0-9_-]*){1,3}$';
const SEMVER = '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$';
// The same UUID forms as the cp's CREDIT_UUID and the app's z.uuid(): RFC version/variant, nil and max.
const UUID = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$';
const HTTPS_URL = '^https://[^\\s]{1,2040}$';
const TRIMMED = '^\\S(.*\\S)?$';
// The ops the cp appends itself; a manifest never names them (design §1.1 operations[].name).
const RELAY_OPERATION = 'mini-app.read';
const CONTEXT_OPERATIONS = Object.freeze(['mini-app.context.read', 'mini-app.context.write']);
const PROVENANCE = 'first-party-reviewed-external';
const DEFAULTS = Object.freeze({ maxRequestBytes: 4096, maxResponseBytes: 262144, timeoutMs: 25000, framing: 'data' });

const text = (max, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra });
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Agent Village mini-app manifest v2',
  description: 'One reviewed mini-app (MINIAPPS-PLATFORM-v2-design.md section 1.1). Closed: a key not named here is refused.',
  type: 'object',
  required: ['manifest', 'id', 'name', 'version', 'description', 'homepage', 'visibility', 'permissions', 'service', 'operations', 'skills'],
  additionalProperties: false,
  properties: {
    manifest: { const: MANIFEST_VERSION },
    id: { type: 'string', pattern: APP_ID },
    name: text(160),
    version: { type: 'string', maxLength: 80, pattern: SEMVER },
    description: text(2000),
    homepage: { type: 'string', pattern: HTTPS_URL },
    owner: {
      type: 'object', required: ['github'], additionalProperties: false,
      properties: {
        github: { anyOf: [{ $ref: '#/$defs/login' }, { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { $ref: '#/$defs/login' } }] },
        org: text(120, { pattern: TRIMMED }),
      },
    },
    credit: {
      type: 'object', required: ['role', 'attendeeId', 'name'], additionalProperties: false,
      properties: {
        role: { enum: ['app', 'product'] },
        attendeeId: { type: 'string', pattern: UUID },
        name: text(120, { pattern: TRIMMED }),
      },
    },
    visibility: { enum: ['sandbox', 'admins', 'everyone'] },
    permissions: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object', required: ['kind', 'label', 'description'], additionalProperties: false,
        properties: { kind: { enum: ['read', 'action'] }, label: text(160), description: { type: 'string', maxLength: 1000 } },
      },
    },
    service: {
      type: 'object', required: ['kind'], additionalProperties: false,
      properties: {
        kind: { enum: ['mcp', 'https-json', 'internal'] },
        baseUrl: { type: 'string', pattern: HTTPS_URL },
        auth: {
          type: 'object', required: ['mode'], additionalProperties: false,
          properties: {
            mode: { enum: ['none', 'oauth', 'app-token'] },
            oauth: {
              type: 'object', required: ['resource', 'scopes', 'discovery'], additionalProperties: false,
              properties: {
                resource: { type: 'string', pattern: HTTPS_URL },
                scopes: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_:.-]{1,64}$' } },
                discovery: { type: 'string', pattern: HTTPS_URL },
              },
            },
            secretRef: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
          },
        },
      },
    },
    operations: { type: 'array', minItems: 1, maxItems: 32, items: { $ref: '#/$defs/operation' } },
    data: {
      type: 'object', additionalProperties: false,
      properties: {
        context: {
          type: 'object', required: ['maxEntries'], additionalProperties: false,
          properties: {
            maxEntries: { type: 'integer', minimum: 1, maximum: 64 },
            ceiling: { enum: ['private', 'village', 'public'] },
          },
        },
      },
    },
    skills: {
      type: 'array', minItems: 1, maxItems: 1,
      items: {
        type: 'object', required: ['name', 'version', 'sha256', 'path'], additionalProperties: false,
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
          version: { type: 'string', maxLength: 80, pattern: SEMVER },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          path: { type: 'string', maxLength: 200, pattern: '^skills/[a-z][a-z0-9-]{0,63}/SKILL\\.md$' },
        },
      },
    },
    events: {
      type: 'object', maxProperties: 16,
      propertyNames: { type: 'string', maxLength: 120, pattern: '^miniapp\\.[a-z0-9][a-z0-9-]{0,39}\\.[a-z][a-z0-9_.-]{0,63}@[1-9][0-9]{0,3}$' },
      additionalProperties: {
        type: 'object', minProperties: 1, maxProperties: 16,
        propertyNames: { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,63}$' },
        additionalProperties: { enum: ['string', 'integer', 'boolean'] },
      },
    },
    legacy: {
      description: 'Phase 0 only: what the v1 entry needs and v2 does not model. Retires with the signed projection.',
      type: 'object', additionalProperties: false,
      properties: {
        provenance: { const: PROVENANCE },
        prefixes: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' } },
        personOnly: {
          type: 'object', required: ['operations', 'permissions'], additionalProperties: false,
          properties: {
            operations: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: OPERATION_NAME } },
            permissions: { type: 'array', maxItems: 32, uniqueItems: true, items: text(160) },
          },
        },
      },
    },
  },
  $defs: {
    login: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' },
    operation: {
      type: 'object', required: ['name', 'class'], additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 100, pattern: OPERATION_NAME },
        class: { enum: ['read', 'write', 'prepare', 'needs-card'] },
        target: {
          anyOf: [
            { type: 'object', required: ['tool'], additionalProperties: false, properties: { tool: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' } } },
            {
              type: 'object', required: ['method', 'path'], additionalProperties: false,
              properties: { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/[A-Za-z0-9/_.-]{0,199}$' } },
            },
          ],
        },
        input: { type: 'object' },
        maxRequestBytes: { type: 'integer', minimum: 1, maximum: 262144 },
        maxResponseBytes: { type: 'integer', minimum: 1, maximum: 26214400 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        framing: { enum: ['data', 'media'] },
        returns: {
          type: 'object', required: ['draftIdPath', 'previewPath', 'previewMaxBytes', 'previewTtlSeconds'], additionalProperties: false,
          properties: {
            draftIdPath: { $ref: '#/$defs/jsonPath' },
            previewPath: { $ref: '#/$defs/jsonPath' },
            previewMaxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
            previewTtlSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
          },
        },
        approval: {
          type: 'object', required: ['prepare'], additionalProperties: false,
          properties: {
            prepare: { type: 'string', maxLength: 100, pattern: OPERATION_NAME },
            summary: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 500 } },
            summaryMaxBytes: { type: 'integer', minimum: 1, maximum: 3000 },
          },
        },
      },
    },
    jsonPath: { type: 'string', maxLength: 200, pattern: '^\\$(\\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,8}$' },
  },
};

// The catalog index (mini-apps/catalog.json): which manifests are published, in the order served.
const INDEX_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', required: ['catalog', 'apps'], additionalProperties: false,
  properties: {
    catalog: { const: MANIFEST_VERSION },
    apps: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: APP_ID } },
  },
};

// ---- The schema interpreter ---------------------------------------------------------------------
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const codePoints = value => { let n = 0; for (const _ of value) n++; return n; };
const regexes = new Map();
const regex = source => {
  if (!regexes.has(source)) regexes.set(source, new RegExp(source, 'u'));
  return regexes.get(source);
};
const TYPES = {
  object: isObject, array: Array.isArray, string: v => typeof v === 'string', boolean: v => typeof v === 'boolean',
  integer: v => Number.isInteger(v), number: v => typeof v === 'number' && Number.isFinite(v),
};
function resolve(root, ref) {
  const m = /^#\/\$defs\/([A-Za-z]+)$/.exec(ref);
  if (!m || !own(root.$defs, m[1])) throw new Error('mini_apps_schema_ref_unknown');
  return root.$defs[m[1]];
}
function walk(schema, value, at, errors, root) {
  if (errors.length >= MAX_ERRORS) return;
  const fail = (reason, where = at) => { if (errors.length < MAX_ERRORS) errors.push({ path: where || '/', reason }); };
  if (own(schema, '$ref')) return walk(resolve(root, schema.$ref), value, at, errors, root);
  if (own(schema, 'anyOf')) {
    if (!schema.anyOf.some(option => { const e = []; walk(option, value, at, e, root); return e.length === 0; })) fail('anyOf');
    return;
  }
  if (own(schema, 'const') && value !== schema.const) return fail('const');
  if (own(schema, 'enum') && !schema.enum.includes(value)) return fail('enum');
  if (own(schema, 'type') && !TYPES[schema.type](value)) return fail('type');
  if (typeof value === 'string') {
    const n = codePoints(value);
    if (own(schema, 'minLength') && n < schema.minLength) fail('minLength');
    if (own(schema, 'maxLength') && n > schema.maxLength) fail('maxLength');
    if (own(schema, 'pattern') && !regex(schema.pattern).test(value)) fail('pattern');
  }
  if (typeof value === 'number') {
    if (own(schema, 'minimum') && value < schema.minimum) fail('minimum');
    if (own(schema, 'maximum') && value > schema.maximum) fail('maximum');
  }
  if (Array.isArray(value)) {
    if (own(schema, 'minItems') && value.length < schema.minItems) fail('minItems');
    if (own(schema, 'maxItems') && value.length > schema.maxItems) return fail('maxItems');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('uniqueItems');
    if (own(schema, 'items')) value.forEach((item, i) => walk(schema.items, item, `${at}/${i}`, errors, root));
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (own(schema, 'minProperties') && keys.length < schema.minProperties) fail('minProperties');
    if (own(schema, 'maxProperties') && keys.length > schema.maxProperties) return fail('maxProperties');
    for (const key of schema.required || []) if (!own(value, key)) fail(`required:${key}`);
    for (const key of keys) {
      const where = `${at}/${key}`;
      if (own(schema, 'propertyNames')) walk(schema.propertyNames, key, where, errors, root);
      if (schema.properties && own(schema.properties, key)) walk(schema.properties[key], value[key], where, errors, root);
      else if (schema.additionalProperties === false) fail('additionalProperties', where);
      else if (isObject(schema.additionalProperties)) walk(schema.additionalProperties, value[key], where, errors, root);
    }
  }
}
/** The schema phase alone: the errors JSON Schema itself gives ([] when the value is schema-valid). */
function checkSchema(value, schema = SCHEMA) {
  const errors = [];
  walk(schema, value, '', errors, schema);
  return errors;
}

// ---- The checks beyond the schema (design §1.1 field rules, §1.3) ---------------------------------
// The secret shapes the PR-review bot also scans (§6.1), and any http: URL or data: URI, in any key or string.
const FORBIDDEN_TEXT = [
  ['http_url', /\bhttp:\/\//i], ['data_uri', /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i],
  ['secret', /\bsk-[A-Za-z0-9_-]{16,}/], ['secret', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ['secret', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./], ['secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['secret', /\bAKIA[0-9A-Z]{16}\b/], ['secret', /\bxox[abposr]-[A-Za-z0-9-]{10,}/], ['secret', /password\s*[=:]/i],
];
function scanText(value, at, fail) {
  if (typeof value === 'string') {
    for (const [reason, pattern] of FORBIDDEN_TEXT) if (pattern.test(value)) return fail(at, reason);
  } else if (Array.isArray(value)) value.forEach((item, i) => scanText(item, `${at}/${i}`, fail));
  else if (isObject(value)) for (const key of Object.keys(value)) { scanText(key, `${at}/${key}`, fail); scanText(value[key], `${at}/${key}`, fail); }
}
function httpsUrl(value, { bare = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && (!bare || (!url.search && !url.hash && !value.includes('?') && !value.includes('#')));
}
const utf8Bytes = value => new TextEncoder().encode(value).length;
function semantics(m, compileInput) {
  const errors = [];
  const fail = (path, reason) => { if (errors.length < MAX_ERRORS) errors.push({ path, reason }); };
  scanText(m, '', fail);
  if (!httpsUrl(m.homepage)) fail('/homepage', 'url');
  const service = m.service, auth = service.auth;
  if (own(service, 'baseUrl') && !httpsUrl(service.baseUrl, { bare: true })) fail('/service/baseUrl', 'url');
  if (service.kind === 'internal') {
    if (own(service, 'baseUrl')) fail('/service/baseUrl', 'internal_has_endpoint');
    if (auth) fail('/service/auth', 'internal_has_auth');
  } else if (!auth) fail('/service/auth', 'auth_required');
  if (auth) {
    if ((auth.mode === 'oauth') !== own(auth, 'oauth')) fail('/service/auth', 'oauth_mismatch');
    if ((auth.mode === 'app-token') !== own(auth, 'secretRef')) fail('/service/auth', 'secret_ref_mismatch');
    if (auth.oauth) {
      if (!httpsUrl(auth.oauth.resource, { bare: true })) fail('/service/auth/oauth/resource', 'url');
      if (!httpsUrl(auth.oauth.discovery, { bare: true })) fail('/service/auth/oauth/discovery', 'url');
    }
  }
  const prefixes = new Set([m.id, ...(m.legacy?.prefixes || [])]);
  if (m.legacy?.prefixes?.some(prefix => prefix === m.id || prefix === 'mini-app')) fail('/legacy/prefixes', 'prefix_reserved');
  const byName = new Map();
  m.operations.forEach((op, i) => {
    const at = `/operations/${i}`;
    if (byName.has(op.name)) fail(`${at}/name`, 'duplicate');
    byName.set(op.name, op);
    if (!prefixes.has(op.name.split('.')[0])) fail(`${at}/name`, 'prefix');
    const target = op.target;
    if (service.kind === 'internal' && target) fail(`${at}/target`, 'internal_has_target');
    if (service.kind === 'mcp' && target && !own(target, 'tool')) fail(`${at}/target`, 'target_kind');
    if (service.kind === 'https-json' && target && !own(target, 'path')) fail(`${at}/target`, 'target_kind');
    const card = op.class === 'needs-card';
    const value = key => own(op, key) ? op[key] : DEFAULTS[key];
    if (card && value('maxRequestBytes') > 65536) fail(`${at}/maxRequestBytes`, 'ceiling');
    if (value('maxResponseBytes') > 262144 && value('framing') !== 'media') fail(`${at}/maxResponseBytes`, 'ceiling');
    if (value('timeoutMs') > 25000 && !card) fail(`${at}/timeoutMs`, 'ceiling');
    if (own(op, 'returns') && op.class !== 'prepare') fail(`${at}/returns`, 'prepare_only');
    if (card !== own(op, 'approval')) fail(`${at}/approval`, card ? 'required' : 'needs_card_only');
    if (own(op, 'input')) {
      if (op.input.type !== 'object') fail(`${at}/input`, 'not_object_schema');
      if (utf8Bytes(JSON.stringify(op.input)) > 16384) fail(`${at}/input`, 'too_large');
      else if (compileInput) {
        try { compileInput(op.input, op); } catch { fail(`${at}/input`, 'uncompilable'); }
      }
    }
  });
  m.operations.forEach((op, i) => {
    if (!op.approval) return;
    const prepare = byName.get(op.approval.prepare);
    if (!prepare || prepare.class !== 'prepare') fail(`/operations/${i}/approval/prepare`, 'unknown_prepare');
  });
  if (m.visibility === 'everyone' && m.data?.context?.ceiling === 'public') fail('/data/context/ceiling', 'lane_ceiling');
  const skill = m.skills[0];
  if (skill.name !== m.id) fail('/skills/0/name', 'not_app_id');
  if (skill.path !== `skills/${skill.name}/SKILL.md`) fail('/skills/0/path', 'not_skill_path');
  for (const name of Object.keys(m.events || {})) if (name.split('.')[1] !== m.id) fail(`/events/${name}`, 'not_app_id');
  const personOnly = m.legacy?.personOnly;
  if (personOnly) {
    personOnly.operations.forEach((name, i) => { if (!byName.has(name)) fail(`/legacy/personOnly/operations/${i}`, 'unknown_operation'); });
    const labels = new Set(m.permissions.map(p => p.label));
    personOnly.permissions.forEach((label, i) => { if (!labels.has(label)) fail(`/legacy/personOnly/permissions/${i}`, 'unknown_permission'); });
    if (personOnly.operations.length >= m.operations.length) fail('/legacy/personOnly/operations', 'empty_base');
    if (personOnly.permissions.length >= m.permissions.length) fail('/legacy/personOnly/permissions', 'empty_base');
  }
  return errors;
}

/**
 * Whether `value` is a v2 manifest. `compileInput(schema, op)` (optional; the cp and app pass ajv 2020
 * strict, as mcp.ts compiles a reviewed tool schema) must throw for an input schema it cannot compile.
 * Returns { ok: true, manifest } (a frozen deep copy) or { ok: false, code, errors: [{ path, reason }] }.
 */
function validateManifest(value, { compileInput } = {}) {
  let errors = checkSchema(value);
  if (!errors.length) errors = semantics(value, compileInput);
  if (errors.length) return { ok: false, code: CODE, errors };
  return { ok: true, manifest: deepFreeze(JSON.parse(JSON.stringify(value))) };
}
/**
 * The published catalog: `index` is mini-apps/catalog.json, `byId` maps each id to its parsed manifest.json
 * (or an Error when it could not be read). An index that fails is a whole-catalog failure (ok: false). A
 * manifest that fails is dropped with a code and the rest serve (design §1.2); so is one whose id is not
 * its index id, or one that reuses another's op name or prefix.
 */
function buildCatalog(index, byId, options = {}) {
  const indexErrors = checkSchema(index, INDEX_SCHEMA);
  if (indexErrors.length) return { ok: false, code: 'mini_apps_catalog_index_invalid', errors: indexErrors };
  const manifests = [], dropped = [], ops = new Map(), prefixes = new Map();
  for (const id of index.apps) {
    const raw = byId && own(byId, id) ? byId[id] : undefined;
    if (raw === undefined || raw instanceof Error) { dropped.push({ id, code: 'mini_apps_manifest_unreadable', errors: [] }); continue; }
    const result = validateManifest(raw, options);
    if (!result.ok) { dropped.push({ id, code: result.code, errors: result.errors }); continue; }
    const m = result.manifest;
    const clash = m.id !== id ? 'id_mismatch'
      : m.operations.some(op => ops.has(op.name)) ? 'operation_taken'
        : [m.id, ...(m.legacy?.prefixes || [])].some(prefix => prefixes.has(prefix)) ? 'prefix_taken' : null;
    if (clash) { dropped.push({ id, code: CODE, errors: [{ path: '/', reason: clash }] }); continue; }
    for (const op of m.operations) ops.set(op.name, m.id);
    for (const prefix of [m.id, ...(m.legacy?.prefixes || [])]) prefixes.set(prefix, m.id);
    manifests.push(m);
  }
  return { ok: true, manifests: Object.freeze(manifests), dropped };
}

// ---- The v1 catalog entry (today's mini-apps-catalog.js shape, key order included) ----------------
const v1Unrepresentable = reason => Object.assign(new Error(V1_CODE), { code: V1_CODE, reason });
/**
 * The v1 entry a valid manifest serves, as today's constants hold it: id, name, description, version,
 * homepage, [provenance, auth, restricted], [credit], permissions, skills, operations, [data], [mcp].
 * `person`: the per-box person entry (legacy.personOnly kept); `context`: the per-box context entry (the
 * generic context ops after the app's own, for an app that declares data.context). A public MCP app
 * (service mcp, auth none) is served as today's generic relay: `mini-app.read` plus an `mcp` block of its
 * ops' tools. A v2 `admins` app is served restricted (the narrower v1 audience: allowlisted tenants only).
 * @returns {Record<string, any>}
 */
function v1Entry(m, { person = false, context = false } = {}) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const personOnly = m.legacy?.personOnly;
  const keepOp = op => person || !personOnly || !personOnly.operations.includes(op.name);
  const keepPermission = p => person || !personOnly || !personOnly.permissions.includes(p.label);
  const relay = m.service.kind === 'mcp' && m.service.auth?.mode === 'none';
  const entry = { id: m.id, name: m.name, description: m.description, version: m.version, homepage: m.homepage };
  if (m.legacy?.provenance) entry.provenance = m.legacy.provenance;
  if (m.service.auth?.mode === 'oauth') entry.auth = 'oauth';
  if (m.visibility !== 'everyone') entry.restricted = true;
  if (m.credit) entry.credit = { role: m.credit.role, attendeeId: m.credit.attendeeId, name: m.credit.name };
  entry.permissions = m.permissions.filter(keepPermission).map(p => ({ kind: p.kind, label: p.label, description: p.description }));
  entry.skills = m.skills.map(skill => skill.name);
  const ops = m.operations.filter(keepOp);
  entry.operations = relay ? [RELAY_OPERATION] : ops.map(op => op.name);
  if (context && m.data?.context) entry.operations.push(...CONTEXT_OPERATIONS);
  if (m.data?.context) entry.data = { context: { maxEntries: m.data.context.maxEntries } };
  if (relay) {
    if (!m.service.baseUrl) throw v1Unrepresentable('relay_without_base_url');
    if (ops.some(op => !op.target?.tool || !op.input)) throw v1Unrepresentable('relay_op_without_tool');
    entry.mcp = { url: m.service.baseUrl, tools: ops.map(op => ({ name: op.target.tool, inputSchema: clone(op.input) })) };
  }
  return entry;
}
/** An op's budgets with the design's defaults filled in (what P0-2 reads instead of hand tables). */
function operationBudgets(op) {
  return Object.freeze(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, own(op, key) ? op[key] : DEFAULTS[key]])));
}
function deepFreeze(value) {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  MANIFEST_VERSION, CODE, V1_CODE, SCHEMA, INDEX_SCHEMA, RELAY_OPERATION, CONTEXT_OPERATIONS, DEFAULTS,
  checkSchema, validateManifest, buildCatalog, v1Entry, operationBudgets, deepFreeze,
};

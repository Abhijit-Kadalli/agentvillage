# Edge Nexus mini-app

## What it is

Edge Nexus is the village knowledge graph of Edge City India 2026
(https://nexus.positivesumexperiments.com): typed nodes (people, projects,
tools, topics), typed links between them, each fact referenced to the source
text it came from, and a git-style history of every change. This mini-app lets
a resident's agent search and read it, and add to it when the owner asks: a
source for the Librarian to read, graph changes, or a proposal for an admin.

- `skills/nexus/SKILL.md`: what the agent does and says.
- `mini-apps/nexus/manifest.json`: the v2 manifest (operations, input schemas,
  budgets, the auth mode).
- `plugins/village-bridge/_nexus.py`: the box-side argument checks and error
  text.

The id is `nexus` because the shared validator reserves the `edge-` family; the
display name is still "Edge Nexus".

## Why app-token

The same link as Edge City Volunteers (`eci-volunteers`): one token between
Agent Village and Edge Nexus, and no second sign-in. Agent Village already
knows each owner's Telegram user id from pairing; Edge Nexus keys people on
their Telegram user id (it signs people in with Telegram). So the app server
holds ONE token for Edge Nexus (`MINI_APP_NEXUS_TOKEN`) and names the owner on
each call; Edge Nexus acts as that resident (an outside agent acting on their
behalf, with their permissions). The owner only installs the mini-app. The box
never sees the token, the endpoint, the Telegram id or a person id.

## The call

Standard MCP (streamable HTTP, JSON responses): `POST` to
`https://nexus.positivesumexperiments.com/api/mcp` with

```
Authorization: Bearer <MINI_APP_NEXUS_TOKEN>
X-Agent-Village-Telegram-User-Id: <the owner's numeric Telegram user id>
X-Agent-Village-Telegram-Username: <the owner's current username, no @>   (optional, recommended)
Accept: application/json, text/event-stream
Content-Type: application/json
```

then `initialize` (protocol `2025-06-18`), `notifications/initialized` and a
`tools/call` of the operation's tool, with the box's `arguments` forwarded
unchanged as the tool's MCP `arguments`. Carry `Mcp-Session-Id` if Edge Nexus
returns one (it is stateless, one server per request, and may not). The
Telegram id and username come from the owner's pairing, never from the box or
the model.

The Edge Nexus side of this contract is in the Edge Nexus repository,
`docs/MINIAPP.md` (code: `apps/web/src/services/mcp/agent-village.ts`).

## Identity on the Edge Nexus side

- The Telegram id is the person. An unknown id **creates** the person (any
  Telegram account can use Edge Nexus), so there is no "not linked yet" refusal
  and nothing for the owner to do first.
- The username header, when sent, refreshes the person's username. A different
  username is accepted (Agent Village's pairing is the source of truth), never
  refused. A malformed one (not 4-32 letters, digits or `_`) is a 401, so the
  app leaves it out rather than sending it.
- The Telegram id must be 1-16 digits and a safe integer; anything else is a 401.
- Every call acts as one "Agent Village" agent on behalf of the resident, with
  the resident's role. Commits and audit rows show actor Agent Village,
  `on_behalf_of` the resident, client `agent-village`.
- An admin revoking that agent switches the whole link off (403).
- **Rate limit: 60 tool calls a minute per resident** (`initialize` and
  `tools/list` do not count). Over it, the tool answers `rate_limited`.

## Operations

| `village` operation | Edge Nexus tool | Class | `maxRequestBytes` |
|---|---|---|---|
| `nexus.initialize` | `nexus_initialize` | read | 4096 |
| `nexus.search` | `nexus_search` | read | 4096 |
| `nexus.get` | `nexus_get` | read | 4096 |
| `nexus.source` | `nexus_source` | read | 4096 |
| `nexus.schema` | `nexus_schema` | read | 4096 |
| `nexus.history` | `nexus_history` | read | 4096 |
| `nexus.changes_since` | `nexus_changes_since` | read | 4096 |
| `nexus.proposals` | `nexus_proposals` | read | 4096 |
| `nexus.submit_source` | `nexus_submit_source` | write | 262144 |
| `nexus.write` | `nexus_write` | write | 262144 |
| `nexus.propose` | `nexus_propose` | write | 131072 |

Every operation: `maxResponseBytes` 262144, `timeoutMs` 25000, framing `data`.
Not exposed: the Librarian's tools (`nexus_jobs_claim`, `nexus_jobs_complete`,
`nexus_jobs_fail`, `nexus_queries`); Edge Nexus does not list them for anyone
but the Librarian either. `mini-app.read` refuses `nexus`.

## Approval classification

This follows the developer guide, section 7: app actions run on their own by
default; only a payment shows a card.

- The eight reads change nothing.
- `submit_source`, `write` and `propose` are `write`. Each is recorded as one
  commit (or one proposal) under the owner's name, and people can revert it in
  Edge Nexus. None is a payment. They add to a graph the whole village reads,
  which is the purpose of the app: the permission card says so ("visible to the
  whole village").
- An attribution (`said_by`) from a resident, and any type Edge Nexus marks as
  needing approval, is not written: Edge Nexus files it as a proposal for an
  admin. Schema changes are proposals only.
- On the box, the three writes take the verified-gate path (zzz.bot's and
  `eci-volunteers.confirm`'s), with no manual grant. If Edge City later pins a
  member row to ask for one, nothing in this manifest needs to change.
- There is no propose/confirm step on the Agent Village side: the owner's ask
  in chat is the instruction, and the skill says to write only what the owner
  asked for or agreed to.

This is not a generic app (section 8 of the guide: token and write partner
apps are mini-apps v3, with per-app app-server code). Reference app-server
code is below.

## Input rules

The `input` schemas are Edge Nexus's own zod tool schemas
(`apps/web/src/services/mcp/schemas.ts` and `ops.ts` in the Edge Nexus repo),
converted to JSON Schema 2020-12 with `z.toJSONSchema` (input side), with
`description`, `default` and `format` dropped and `"additionalProperties":
false` on every object that is not a free-form record (node `properties` and a
proposal's `payload` stay open, as in Edge Nexus). The app should check each
call against them and its `maxRequestBytes` (UTF-8 bytes of the compact JSON
arguments) and refuse anything else with `invalid_arguments`.

The box (`_nexus.py`) checks the same, and adds three rules for agents that
Edge Nexus enforces too (its recorder refuses an agent operation without them):

- every graph op in `nexus.write`, and in a proposal's `heldWork`, carries a
  `confidence` (0 to 1) and a non-empty `rationale`;
- `nexus.propose` carries a `confidence`;
- no op says `how: "confirmed"` (only a person confirms a fact), including a
  node, edge or attribution proposal's `payload.op`.

Anything else is `invalid_nexus_arguments` before transport, with the box's
own text. The box sends `X-Village-Operation: <operation>` for the three writes
(the larger request budgets).

The schemas keep Edge Nexus's own bounds; the byte budgets are the real limit
on a long source (a 2,000,000-character source is valid in Edge Nexus but does
not fit 262,144 bytes). The skill tells the agent to split a longer source.

## Edge Nexus's refusals

Before MCP (the response body, before any tool runs), always `{code, detail}`:

| Edge Nexus answers | When | The app answers the box |
|---|---|---|
| HTTP 401 `not_authorized` | The token is unknown (the body also carries OAuth's `error` and `error_description`), or the Telegram id header is missing or not a positive integer, or the username header is malformed | `unavailable`: an Agent Village configuration problem; never show the resident text for `not_authorized` |
| HTTP 403 `not_authorized` | An Edge Nexus admin revoked the Agent Village agent: the link is off for everyone | `not_authorized` |

Anything else before MCP (a 5xx, an unexpected body) is `unavailable` for a
503 and otherwise `connection_or_request_refused`, which tells the agent not to
claim a write landed and to read before writing again. JSON-RPC `-32602` is
`invalid_arguments`.

A tool's own refusal is an MCP result with `isError: true`, the text part
`CODE: message`, and `structuredContent: {code, detail}`, with Edge Nexus's
mapping of its `ServiceError` codes:

| Edge Nexus code | `code` | The app |
|---|---|---|
| `INVALID` | `invalid_arguments` | passes the result through as data (the detail says what to fix) |
| `UNAUTHENTICATED` | `not_connected` | answers the box `not_connected` |
| `FORBIDDEN` (the resident may not) | `not_authorized` | passes it through as data |
| `NOT_FOUND`, `GONE` | `not_found` | passes it through as data |
| `CONFLICT`, `STALE_VERSION` | `conflict` | passes it through as data |
| `RATE_LIMITED` | `rate_limited` | answers the box `rate_limited` |
| anything unexpected | `unavailable` | answers the box `unavailable` |

So the codes the box sees as refusals are `not_connected`, `not_authorized`,
`unavailable`, `invalid_arguments` (the app's own input check) and
`rate_limited`; it replaces each with its own text (`_nexus.py`
`NEXUS_ERRORS`), never upstream wording. A tool refusal passed as data reaches
the agent framed as untrusted, with Edge Nexus's `detail`.

## Results

Return the MCP result as
`{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
Edge Nexus writes most results only as JSON (its text part is then exactly
`JSON.stringify(structuredContent)`); the app sends `text: ""` in that case so
the answer is not carried twice. The box frames the result as untrusted data
and scrubs hidden characters at every depth, replacing each with spaces.

**Offsets.** Edge Nexus's evidence spans (`{sourceId, start, end}`) and
`nexus.source` offsets are JavaScript string offsets: UTF-16 code units, end
exclusive. The box never recounts or rewrites them: it passes `start`, `end`
and `offset` through as numbers, and its scrubber keeps the UTF-16 length of
every string (a hidden character outside the BMP becomes two spaces), so an
offset Edge Nexus returned still points at the same text. The skill tells the
agent to copy `start` and `end` from passage hits, never to count them. Responses are capped at
262,144 bytes; the skill reads sources in 20,000-character slices.

## Edge Nexus side safety (its repository, `docs/MINIAPP.md`, is authoritative)

- The token speaks for every resident; Edge Nexus knows it only by its sha256
  hash (`AGENT_VILLAGE_TOKENS`, several while rotating).
- An Agent Village call acts as the Agent Village agent on behalf of the person
  with that Telegram id, with that person's role: only the eleven resident
  tools are listed or run, never the Librarian's.
- Every change is a commit with the person, the door (Agent Village) and the
  agent's confidence and rationale in the audit log; people can revert it.
- Search words are stored without who asked.

## Rollout

1. This overlay roll (box side: allowlist, bridge, skill). Older boxes refuse a
   projection that names `nexus`, Gold Stars included, so it comes first.
2. The CP catalog row (`nexus` 1.0.0, the eleven operations in this order,
   `restricted`) and the `MINI_APPS_TENANT_ALLOWLIST` entry for the sandbox
   tenant.
3. The app routes: the operation map, the headers, the refusal mapping and the
   budgets (see the reference implementation).
4. The token. Naman holds it and gives it to Edge City staff privately for the
   Agent Village app server's `MINI_APP_NEXUS_TOKEN`. Never in a pull request.

## Reference implementation

[`docs/reference/nexus/app-server.ts`](../../docs/reference/nexus/app-server.ts)
is reference code for Edge City's app server: the operation map, the input
check against this manifest, the MCP call, the refusal mapping and the
budgets, with tests (`app-server.test.ts`, a fake fetch, no network). It is
not run on any box. It lives under `docs/` because `mini-apps/` is a closed
tree of manifests and READMEs only.

## V0 conformance evidence

The fixtures in
[`scripts/tests/fixtures/nexus/`](../../scripts/tests/fixtures/nexus/) are
Edge Nexus's own bodies, recorded on 25 October from its code (Edge Nexus main
`24fc444`, a local run of its MCP route against its test database, the way its
`agent-village.db.test.ts` calls it):

| Fixture | What | Body |
|---|---|---|
| `nexus.initialize/error-telegram-id-missing.json` | no identity header | 401 `{code: not_authorized, detail}` |
| `nexus.initialize/error-username-malformed.json` | a malformed username header | 401 `{code: not_authorized, detail}` |
| `nexus.search/error-revoked.json` | the Agent Village agent revoked | 403 `{code: not_authorized, detail}` |
| `nexus.search/error-invalid-arguments.json` | no `q` | MCP `isError` result, `{code: invalid_arguments}` |
| `nexus.get/error-not-found.json` | an unknown path | MCP `isError` result, `{code: not_found}` |
| `nexus.source/error-not-found.json` | an unknown source id | MCP `isError` result, `{code: not_found}` |
| `nexus.write/error-no-confidence.json` | a graph op without a confidence | MCP `isError` result, `{code: invalid_arguments}` |
| `nexus.schema/error-rate-limited.json` | over 60 calls a minute | MCP `isError` result, `{code: rate_limited}` |

The rate-limit body was recorded with the limit lowered for the run; its text
says 60, as production does. Not a fixture: the unknown-token 401, because its
body adds OAuth's `error` and `error_description` beside `{code, detail}`
(conformance takes exactly `{code, detail}`); the app maps every 401 to
`unavailable` anyway. No success fixture is invented.

```sh
bun run conformance -- mini-apps/nexus/manifest.json \
  --fixtures scripts/tests/fixtures/nexus --base origin/main \
  --out "$TMPDIR/conformance.json"
```

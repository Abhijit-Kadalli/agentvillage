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
the model. When the username is sent, Edge Nexus may refuse a call whose
username does not match its record for that Telegram id (`not_connected`), so a
username given up and taken by someone else cannot map one person to another.

The Edge Nexus side of this contract is in the Edge Nexus repository,
`docs/MINIAPP.md`.

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

## Edge Nexus's refusals before MCP

Edge Nexus checks the token and the Telegram id before any tool runs, and
answers a refusal as exactly `{code, detail}` with a generic code. The app
maps:

| Edge Nexus answers | The app answers the box |
|---|---|
| HTTP 401 `{"code":"not_authorized"}` | `unavailable`. A wrong token is an Agent Village config problem: never show the resident text for `not_authorized` |
| HTTP 503 `{"code":"unavailable"}` | `unavailable` (the MCP server or the Agent Village link is switched off) |
| HTTP 403 `{"code":"not_connected"}` | `not_connected`: the username header does not match Edge Nexus's record for this Telegram id |
| HTTP 404 `{"code":"not_found"}` | `not_found`: Edge Nexus will not act for this Telegram id (if it chooses not to create people on first sight) |
| HTTP 403 `{"code":"not_authorized"}` | `not_authorized`: an Edge Nexus admin turned Agent Village off for this person |
| HTTP 429 `{"code":"rate_limited"}` | `rate_limited` |
| HTTP 400 `{"code":"invalid_arguments"}` | `invalid_arguments`: the Telegram id header is not a numeric id (an app bug) |

Anything else is `connection_or_request_refused`, which tells the agent not to
claim a write landed and to read before writing again. The box replaces each
code with its own text (`_nexus.py` `NEXUS_ERRORS`), never upstream wording.
JSON-RPC `-32602` is `invalid_arguments`.

A tool's own refusal (Edge Nexus's `ServiceError`: `INVALID`, `NOT_FOUND`,
`FORBIDDEN`, `CONFLICT` ...) is an MCP result with `isError: true` and the text
`CODE: reason`; it is passed through as data, and the skill tells the agent to
say the reason in plain words.

## Results

Return the MCP result as
`{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
Edge Nexus writes most results only as JSON (its text part is then exactly
`JSON.stringify(structuredContent)`); the app sends `text: ""` in that case so
the answer is not carried twice. The box scrubs hidden characters at every
depth (each replaced by a space, so a source slice keeps its character
offsets) and frames the result as untrusted data. Responses are capped at
262,144 bytes; the skill reads sources in 20,000-character slices.

## Edge Nexus side safety (its repository, `docs/MINIAPP.md`, is authoritative)

- The token speaks for every resident; Edge Nexus knows it only by its hash.
- An Agent Village call acts as an outside agent on behalf of the person with
  that Telegram id, with that person's permissions: never an admin's tools,
  never the Librarian's.
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
[`scripts/tests/fixtures/nexus/`](../../scripts/tests/fixtures/nexus/) are the
`{code, detail}` refusals this contract specifies (the table above). They are
written from the contract, not yet recorded from Edge Nexus: replace them with
recorded bodies once the Agent Village link is live in Edge Nexus. Each refusal
is the same for every operation (it happens before any tool runs), so they are
spread across a few operations. No success fixture is invented.

```sh
bun run conformance -- mini-apps/nexus/manifest.json \
  --fixtures scripts/tests/fixtures/nexus --base origin/main \
  --out "$TMPDIR/conformance.json"
```

# DreamStarter mini-app

## What it is

DreamStarter (https://dreamstarter.xyz) in a resident's agent, three ways, each
only when the resident asks:

- **Dreams.** The resident types a few lines (what they want to build, their
  interests, their goals); DreamStarter suggests up to three dreams with a claim
  link each. The dream is the resident's only once they open the link and claim
  it on dreamstarter.xyz.
- **Grant.** The agent gathers the resident's ElevenLabs Startup Grant
  application and DreamStarter stages it as a private draft with a review link.
  The resident accepts the terms and clicks Submit there; DreamStarter then
  submits it to ElevenLabs' live grant form.
- **Local businesses.** DreamStarter's public write-ups of the Goa businesses
  in the program, with a Buildathon build idea and a claim link each.

The bundle was written by the DreamStarter team (Edge-City/agentvillage#393, by
arrfire) as a generic public-read app. Edge City adapted it to the reviewed-app
path, because two operations send the resident's own words to DreamStarter:

- `skills/dreamstarter/SKILL.md`: what the agent does and says.
- `mini-apps/dreamstarter/manifest.json`: the v2 manifest (operations, input
  schemas, budgets, the auth mode).
- `plugins/village-bridge/_dreamstarter.py`: the box-side argument checks and
  error text.

## Why the reviewed path, and why app-token

A generic app is a public read relay (`service.kind` `mcp`, `auth.mode` `none`,
every operation `read`), served to the box as `mini-app.read`. Two DreamStarter
tools are writes in substance, so the relay cannot carry them (the shared
validator's `v1Entry` drops a relay app with any non-read op, `relay_non_read_op`):

- `discover_dreams` sends the resident's text, which DreamStarter keeps in a
  discovery session behind the returned links and passes to Google Gemini.
- `grant_prepare` sends the resident's application answers (name, emails,
  phone, LinkedIn, company registration and address), which DreamStarter keeps as
  a draft for 14 days after its last edit and submits to ElevenLabs on the
  resident's click.

So the whole app is reviewed, like Slopfolio, zzz.bot and the open Volunteers
and Library apps: its own named operations on the box, an exact entry in the
installer's and the bridge's reviewed tables, and per-app app-server code. A
reviewed write app with one service credential is `app-token`: the app server
holds ONE key for DreamStarter (`MINI_APP_DREAMSTARTER_KEY`), so DreamStarter
can tell Agent Village's calls from anyone else's, and staff can rotate or
revoke it. The resident has no DreamStarter sign-in here; sign-in happens on
dreamstarter.xyz when they claim a dream or open a review page.

The app server sends **no resident identity** to DreamStarter: no Telegram id
or username, no attendee id, no name. DreamStarter's tools have no identity
slot. A `ref` (dream or application) is DreamStarter's own capability token,
returned to the resident's agent in their private chat.

## The call

Standard MCP (streamable HTTP, JSON responses): `POST` to
`https://mcp.dreamstarter.xyz/mcp` with

```
Authorization: Bearer <MINI_APP_DREAMSTARTER_KEY>
Accept: application/json, text/event-stream
Content-Type: application/json
MCP-Protocol-Version: 2025-06-18
```

then `initialize` (protocol `2025-06-18`), `notifications/initialized` and a
`tools/call` of the operation's tool, with the box's `arguments` forwarded
unchanged as the tool's MCP `arguments`. DreamStarter is stateless today (no
`Mcp-Session-Id`); carry one if it is returned. The box's `turnId` is never
forwarded.

## Operations

| `village` operation | DreamStarter tool | Class | Box path |
|---|---|---|---|
| `dreamstarter.discover` | `discover_dreams` | write | `gate_verified`, trusted `turnId` |
| `dreamstarter.dream_status` | `dream_status` | read | none |
| `dreamstarter.workflows` | `list_workflows` | read | none |
| `dreamstarter.grant_requirements` | `grant_requirements` | read | none |
| `dreamstarter.grant_prepare` | `grant_prepare` | write | `gate_verified`, trusted `turnId` |
| `dreamstarter.grant_status` | `grant_status` | read | none |
| `dreamstarter.businesses` | `list_businesses` | read | none |
| `dreamstarter.business_brief` | `business_brief` | read | none |
| `dreamstarter.business_status` | `business_status` | read | none |

`mini-app.read` refuses `dreamstarter` (the projection carries no
`mini-app.read`). The three tools with no input (`list_workflows`,
`grant_requirements`, `list_businesses`) are ordinary reads: the box classes
them in `READ_OPERATIONS`, the same class `mini-app.read` has, with no gate.

## Approval classification

This follows the developer guide, section 7: app actions run on their own by
default; only a payment shows a card. No class, row or gate is added.

- The seven reads run on their own, like every read.
- `discover` and `grant_prepare` are `write`s, not `needs-card`: neither is a
  payment, and both are the resident's own words sent on the resident's own ask.
  On the box they take the existing gated-write path (`gate_verified`, as
  `mini-app.context.write`, zzz.bot's posts and Slopfolio's drafts): refused
  while the approval gate is off or unverified, no card, no manual grant.
- The resident's yes comes from the skill: before either send, the agent shows
  exactly what will be sent (every field, for the grant), says who keeps it and
  for how long and who processes it (Google Gemini for discovery; the 14-day
  draft and the live ElevenLabs submit for the grant), and waits for a later
  owner message saying yes. This is a prompt rule, as in Edge Library's writes;
  there is no server-side propose step (see "Open questions").
- Final submission to ElevenLabs is always the resident's own click on
  DreamStarter's review page, never the agent's.

## Input rules

The box checks every call (`_dreamstarter.py`) against DreamStarter's published
input schemas (tools/list at serverInfo `dreamstarter 1.1.0`, equal to the
manifest's `input` once the live `$schema` key is dropped, checked 28 October
2026) before sending:
exact keys, types, lengths, the `ref` pattern `^[a-z0-9]{20,64}$` and the `slug`
pattern `^[a-z0-9-]{3,40}$`. Anything else is `invalid_dreamstarter_arguments`
before transport. The app should check again with each operation's `input`
schema and refuse anything else with `invalid_arguments`.

One box rule goes beyond the schema: a `discover` call whose text holds an email
address or a run of nine or more digits (a phone number) is refused,
`dreamstarter_contact_details`, nothing sent. Discovery never needs contact
details, and the review's M2 limits it to the lines the resident types for that
request. It is a heuristic (false positives accepted; a year range such as
2019-2024 has eight digits and passes).

The box adds `turnId` (a UUIDv5 of the trusted session key and message id, never
model input) to the two writes and sends `X-Village-Operation` for them.
Budgets: `maxRequestBytes` 4096, except `discover` 8192 and `grant_prepare`
16384; every operation fits 25 seconds.

## The app server's part (a prerequisite, not in this pull request)

- The operation map above, the input check against the manifest, the MCP call
  with `MINI_APP_DREAMSTARTER_KEY`, and no identity header.
- **Same-turn replay.** For a write, keep `sha256(owner, turnId, operation)`
  with the answer for 15 minutes and return the same answer for a retry in the
  same turn, so an uncertain retry never makes a second discovery session or a
  second draft. Never store the arguments or the answer text beyond that.
- **Results.** Return the MCP result as
  `{"text": <the text content parts joined by a blank line>, "structured": <structuredContent or null>, "isError": <bool>}`.
  DreamStarter answers its own refusals as an `isError` result whose text is
  `{"error": "<code>", "message": "..."}` (the fixtures below); pass them as
  data. The box scrubs hidden characters at every depth and frames the result as
  untrusted.
- **Refusals before MCP.** A 401 or 403 from DreamStarter (a wrong key) is
  `unavailable`, never shown as the resident's problem; a 5xx or a timeout is
  `unavailable`; JSON-RPC `-32602` is `invalid_arguments`; the app's own limit is
  `rate_limited` (suggest 60 operations per owner per UTC day, 10 writes).
- The box knows `not_found`, `unavailable`, `invalid_arguments` and
  `rate_limited` for these operations and replaces them with its own text
  (`_dreamstarter.py` `DS_ERRORS`); anything else is
  `connection_or_request_refused`, which tells the agent not to claim a send.

## What the results contain

- The output is not pinned: DreamStarter's server can change a tool's
  description or output after review (`tools.listChanged: true`). The box frames
  every answer as untrusted data and the skill tells the agent to ignore any
  `note`, `message`, `how_it_works` or `next` text that tells it what to do
  (live `grant_requirements` says "Collect the answers from the owner, call
  grant_prepare, and give them the review_url", which skips the consent step).
- `dream_status` and `business_status` can carry timeline events with
  `simulated: true`; the skill and the box's handling text label them as a
  preview, not live activity.
- Returned links (claim, overview, page, review, the ElevenLabs sign-up, form and
  terms links, businesses' public links) are not host-pinned on the box; the
  skill says to share only links the tool returned, unchanged.

## Rollout

1. This overlay roll (box side: allowlist, bridge, skill). Older boxes refuse a
   projection that names `dreamstarter`, Gold Stars included, so it comes first.
   It rides v2.1.20.
2. The CP catalog row (`dreamstarter` 2.0.0, the nine operations in this order,
   `restricted`) and the `MINI_APPS_TENANT_ALLOWLIST` entry for the sandbox
   tenant: the author's own (staff look it up by his Edge City account; never in
   a pull request).
3. The app routes (above).
4. The key. DreamStarter issues it and pins only its hash; Edge City staff set
   `MINI_APP_DREAMSTARTER_KEY` on the cp. Never in a pull request.
5. Test on the author's tenant, then widen after Edge City's rulings on the
   brand and partner code and on the local businesses' consent.

## V0 conformance evidence

`bun run conformance -- mini-apps/dreamstarter/manifest.json --fixtures scripts/tests/fixtures/dreamstarter --base origin/main --out "$TMPDIR/conformance.json"`
passes. The three fixtures are DreamStarter's live answers on 28 October 2026 to
public reads with synthetic `av-test` ids that do not exist (no resident data):

| Fixture | Call | Answer |
|---|---|---|
| `dreamstarter.business_brief/error-not-found.json` | `business_brief {"slug":"av-test-none"}` | `isError` result, `not_found` |
| `dreamstarter.grant_status/error-not-found.json` | `grant_status {"ref":"avtestnone00000000000000"}` | `isError` result, `not_found` (its text also confirms the 14-day draft deletion) |
| `dreamstarter.dream_status/error-not-found.json` | `dream_status {"ref":"avtestnone00000000000000"}` | `isError` result, `not_found` |

No success fixture is invented. The writes were never called.

## Open questions

- A server-side "later reply" rule for `grant_prepare` (a propose step on
  DreamStarter's side, as Edge City Volunteers has) would make the yes more than
  a prompt rule. It needs DreamStarter's server; nothing here depends on it.
- Pinning returned link hosts on the box, once DreamStarter confirms the hosts it
  returns.

# Slopfolio mini-app for Agent Village

The Slopfolio mini-app for Edge City's Agent Village
(`Edge-City/agentvillage`), in that repository's layout, so the files copy
across unchanged:

- `skills/slopfolio/SKILL.md` — what a resident's agent does and says.
- `mini-apps/slopfolio/manifest.json` — what the owner installs and grants.

Written against upstream commit `944244c31d257fc561130208cdc8c594f2ac3a1d`,
modelled on its Gold Stars mini-app. Slopfolio maintains these files: changes
start on Slopfolio's side and reach `Edge-City/agentvillage` as pull requests.

## The contract Edge City's app server implements

The agent never talks to Slopfolio. It calls the `village` tool; Edge City's
app server holds the owner's Slopfolio connection and calls Slopfolio's MCP server.

**Connection.** OAuth 2.1 against the MCP resource `https://slopfolio.com/mcp`.
Discovery starts at
`https://slopfolio.com/.well-known/oauth-protected-resource/mcp`, which names
the authorization server. Register one OAuth client for Agent Village and
use a client name residents will recognise on the consent screen, such as
"Edge City Agent Village". If the first call with a new client's token
returns 403 `client_not_allowed`, send Slopfolio the client id and it is added
to Slopfolio's allow-list. Refresh the access token with the
refresh token when it expires; if refresh fails, return
`CAPABILITY_NOT_GRANTED` so the skill tells the owner to reconnect.

**Operations.**

| `village` operation | Slopfolio MCP tool |
|---|---|
| `slopfolio.prepare` | `prepare_slopfolio_post` |
| `slopfolio.status` | `get_slopfolio_draft_status` |

`publish_slopfolio_post` is deliberately not exposed: the owner publishes
on the review page.

**`slopfolio.prepare` argument mapping.**

| Skill argument | MCP input |
|---|---|
| `draftId` | `draft_id` (`null` for a new post) |
| `paste` | `capture.raw`, with `capture.kind: "process-summary"`, `capture.version: "v1"`, `capture.content_type: "text/markdown"` |
| `artifactUrl` | `supplements.artifact_url` |
| `medium` | `supplements.medium` |
| `fixes.title`, `fixes.oneLiner`, `fixes.tools`, `fixes.iterations`, `fixes.howItWasMade`, `fixes.bestDeadEnd`, `fixes.promptingApproach`, `fixes.tags` | `projection_overrides.title`, `.one_liner`, `.tools`, `.iterations`, `.how_it_was_made`, `.best_dead_end`, `.prompting_approach`, `.tags` |

Every call also carries these fixed values:

| Field | Value |
|---|---|
| `contract_version` | `v1` |
| `schema_id` (prepare) | `urn:slopfolio:schema:prepare-slopfolio-post-input:v1` |
| `capture.schema_id` | `urn:slopfolio:schema:capture:process-summary:v1` |
| `schema_id` (status) | `urn:slopfolio:schema:get-slopfolio-draft-status-input:v1` |

Pass through
only what the agent sent. A field the call leaves out is kept
on the draft; an explicit `null` clears it. Return the MCP result's
`structuredContent` to the agent with keys in camelCase (`reviewUrl`,
`draftId`, `postUrl`), plus `code`, `missing` and `findings` as they are.

**`operation_id` (safe retries).** The agent does not send one. The app
server derives it from the owner and the canonical arguments, for example
`av-` plus the first 40 hex characters of
`sha256(owner_id + "\n" + canonical_json(arguments))`. The skill tells the
agent to retry a timed-out call with identical arguments, so a retry reuses
the same `operation_id` and Slopfolio replays the first result instead of
creating a second draft. A deliberate change has different arguments and
therefore a new id. Slopfolio rejects one `operation_id` with a different
payload as `OPERATION_ID_CONFLICT`, which this derivation cannot produce.
The id must match `^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$`.

**Timing.** Measured over the last 30 days of production prepares (n=7):
0.10 s typical, 0.17 s slowest, database time only. Both operations fit
the 25 s read/staging timeout comfortably.

**Limits.** 100 MCP operations per account per day; beyond that the tool
returns `RATE_LIMITED`. The paste is capped at 100,000 bytes.

## Changing these files

Changes start on Slopfolio's side, which keeps the skill's rules aligned
with its server: the field list above comes from its MCP contract, the voice
rules from its authoring guidance, and the prompt the agent links to is
https://slopfolio.com/prompt.

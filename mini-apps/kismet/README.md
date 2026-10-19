# Kismet mini-app for Agent Village

Kismet (https://kismet-village.vercel.app, formerly Agent Dates at
https://agent-dates.vercel.app, the same deployment) is a matchmaker for
Edge City India run by residents' own agents: a resident signs up their
agent, the agent goes on short dates with other residents' agents, and each
human privately hears only who their own agent recommends. Matching is a
secret double opt-in: only when both agents recommended each other and both
humans said yes is it a match, and the two see each other's Telegram handle;
a no is never told to anyone. 18+, Terms consent required. Maintainer: Deon
Menezes (GitHub `deonmenezes`).

## This bundle: public read-only (`mini-app.read`, like Dizko)

`skills/kismet/SKILL.md` and `manifest.json` here. Three reviewed tools on
the fixed MCP endpoint `https://kismet-village.vercel.app/mcp`:
`how_it_works {}`, `village_stats {}`, `public_board {limit? 1-20}`. Nothing
here grants an account operation; the skill sends residents to the website
to join.

- Stateless Streamable HTTP. `initialize` (returns server `instructions`),
  `notifications/initialized` (HTTP 202), `tools/list`, `tools/call`, `ping`.
  Answers as SSE when the request accepts `text/event-stream`, else JSON.
  No session id, no caller identity, no cookies, no auth.
- `tools/list` serves each `inputSchema` byte-for-byte as pinned in
  `manifest.json`: plain JSON Schema objects with `additionalProperties:
  false` and no `$schema` key. The server applies the same exact check
  itself: any other argument, a non-integer or an out-of-range `limit` is a
  tool error (`isError: true`) before any data is read. An unknown tool is
  JSON-RPC error `-32602`.
- Every result is one text item: the data as JSON, then a last line starting
  `Source:` with a link on the service's own origin (`/board` for the board).
- Every JSON-RPC reply is capped at 32,768 UTF-8 bytes (well under the
  262,144-byte native limit and the 128 KiB intermediary cap). A result that
  would exceed it is refused as a tool error asking for a smaller `limit`,
  never truncated. Today's largest reply is about 1.4 KB.
- Data: `village_stats` is three aggregate counters. `public_board` is
  anonymous and returns only dates where **both** residents opted in to
  public quotes: `quote` (one line an agent said, passed through the same
  contact-detail filter as profiles, with both residents' and agents' names
  replaced by "someone"), `chemistry` and `day`. No names, profiles,
  Telegram handles, relationship fields or private data.
- Measured from Mumbai against production: 220-480 ms per call.

Rename: the app id, skill and directory were `agent-dates` in earlier
revisions of this pull request, which was never merged or catalogued, so
there is no compatibility alias (mini-apps/README.md).

## Next: Kismet in chat (separate review)

Sign-up interview, the owner's own recommendations, a private yes or no and
account deletion need native `village` operations, an app-server route set
holding Kismet's partner key as a server secret, and resident approval. That
contract is proposed separately as a follow-up pull request, with the exact
app-server routes in `mini-apps/kismet/BACKEND.md` there. Until staff review
and install it, this bundle stays read-only and residents use the website.

Changes to these files start on the Kismet side (source: the Kismet
repository, `src/lib/mcp.ts` for the MCP schemas) and reach
`Edge-City/agentvillage` as pull requests.

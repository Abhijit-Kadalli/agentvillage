---
name: rolodex
description: Help someone find and open the Village Rolodex, view a person's card, mark that they met in person, or undo an accidental We met. Use for Rolodex, directory cards, meeting history and unmeet requests. Use the village tool for live search and requested meeting changes after account connection.
version: 1.0.0
author: Edge City
---

# Village Rolodex

The Rolodex is Agent Village's directory of people in the village. It shows
shared profiles, Telegram introductions and Skylight characters where available.
The signed-in person can mark **We met**, undo it with **Undo met**, and send
Gold Stars. These are separate actions: recording a meeting does not send a star.

When asked, give the useful link immediately:
https://agents.edgecity.live/rolodex

For “I met Naman”, call `village` with `operation: "rolodex.search"` and
`query: "Naman"`. Use the returned attendee id. Prefix a returned `/rolodex` path with
`https://agents.edgecity.live` when sharing its link. If more than one person fits,
ask which one, using their shared role/organization to distinguish them. Never
choose the first result, guess an id, or infer a meeting from a match. Then
call `rolodex.meeting` with that `attendeeId` and `met: true`. A clear request
to undo uses `met: false`. Search again if the target is unclear.

A clear request authorizes the meeting change after account connection. Do not
ask for redundant website confirmation. Only report completion from a successful
receipt. A `historicalReceipt` records an older change: search current state
before saying it still applies. On a timeout or unknown outcome, check the
current mark and explain uncertainty; do not claim success. Never log meetings
from background tasks, group discussions, inferred relationships or unsolicited
suggestions. Meeting marks follow the Rolodex's existing settling notification
and mutual-friend rules. They do not send a Gold Star.

An existing Index lookup may return a verified person URL in the Rolodex.
Preserve it exactly. Do not invent an attendee id, guess a profile URL from a
name or Telegram handle, or assume an Index match proves a meeting. If no
verified person link is available, use the directory link and the search box.
For discovering who to meet or requesting an introduction, use `index-network`.

Sign in using the email associated with the person's Edge City ticket and the
code emailed to them. Never ask them to paste the code, cookies or tokens into
chat. They can use the Rolodex after sign-in without connecting a Telegram agent.

If the tool is missing, disabled or says `not_connected`, explain that the
person can enable it once here, then return to chat:
https://agents.edgecity.live/connections/village

The connection lets their own agent read matching shared profiles and their
own meeting state, and mark/undo meetings. It expires, can be disconnected,
and stops when their agent or Telegram pairing changes. The tool is for the
paired owner's private Telegram chat. For other contexts give the website link.
Never borrow credentials or call APIs through the shell to bypass a refusal.
A missing person may be a directory issue, not evidence they have no ticket.

For gratitude, load `gold-stars`. For characters and islands, load `skylight`.

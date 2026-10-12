---
name: rolodex
description: Help someone find and open the Village Rolodex, view a person's card, mark that they met in person, or undo an accidental We met. Use for Rolodex, directory cards, meeting history and unmeet requests. This release provides website navigation, not live account reads or chat writes.
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

For “I met Naman”, say: “Open the Rolodex, search for Naman, and tap We met on
the right card.” Include the link. You have not recorded the meeting. If they
marked someone by mistake, direct them to **Undo met** on that card or profile.
Do not confuse “we met” with an Index opportunity's accept or outcome controls.

An existing Index lookup may return a verified person URL in the Rolodex.
Preserve it exactly. Do not invent an attendee id, guess a profile URL from a
name or Telegram handle, or assume an Index match proves a meeting. If no
verified person link is available, use the directory link and the search box.
For discovering who to meet or requesting an introduction, use `index-network`.

Sign in using the email associated with the person's Edge City ticket and the
code emailed to them. Never ask them to paste the code, cookies or tokens into
chat. They can use the Rolodex after sign-in without connecting a Telegram agent.

This skill does not read their live meeting list or update it. Say plainly
when you cannot check a live state; never infer it from memory, earlier chat,
an avatar's appearance or a link being opened. Never use administrator keys,
browser sessions, shell requests or another service's credentials to bypass
this boundary. A missing person may be a directory issue: do not claim they
have no ticket based on their absence.

For gratitude, load `gold-stars`. For characters and islands, load `skylight`.

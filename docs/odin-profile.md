# Installing as ODIN

ODIN is the village god agent: it serves the whole village, not one resident,
and answers to the organisers. This overlay installs as ODIN instead of as a
resident's agent (Edge) when `AV_PROFILE=odin`. The change is files and the
installer only.

## Install

```
AV_PROFILE=odin HERMES_HOME=/path/to/hermes-home bun install/install.ts
```

`AV_PROFILE` is `resident` (default, unchanged behaviour) or `odin`; any other
value stops the installer. With `odin` the installer writes, instead of the
resident files:

- `$HERMES_HOME/SOUL.md` from `workspace/odin/SOUL.md`
- `$HERMES_HOME/AGENTS.md` from `workspace/odin/AGENTS.md`

The resident `USER.md` is not installed. `install/reset.ts` removes the same
`SOUL.md` and `AGENTS.md` under either profile and never touches `constitution.md`.
Set `AV_PROFILE` the same way on every re-run of the installer, or the resident
files replace ODIN's.

## The constitution

No constitution text is in this repo. SOUL.md ends with a `## Village
constitution` section. At install time the installer fills it from
`$HERMES_HOME/constitution.md`:

- file present and not empty: its text, verbatim;
- file absent or empty: the single line `(no constitution adopted yet)`.

The operator obtains the text from the app's owner-only soul export and saves it
as `$HERMES_HOME/constitution.md` before running the installer. To adopt or
change it later, replace that file and re-run the installer: SOUL.md is
rebuilt on every run (except with `--preserve-context` when one already exists).

## Not built

This profile is identity only. There is no ODS tool, no data access of any kind
(ODIN's "village-level data only" is a rule in its soul, not a mechanism), no
posting to residents, and no allocation. Nothing here gives ODIN a tool, plugin,
network or database access; those need their own work and the organisers'
approval.

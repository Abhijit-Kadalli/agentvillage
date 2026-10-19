"""Product-owned words for a mini-app the resident has not installed. Every install string the agent sees is here.

MINIAPP-INSTALL-LINK (v2.1.5; lead ASSIGN CLAIMS L13329, product copy L13345,
lanes-product/MINIAPP-INSTALL-SUGGESTION-copy.md). Carter's rule: the agent never sends the resident to the team
or the organisers, and always gives a one-tap path; it cannot install anything itself, and the resident's tap is
the consent. Swap a string here and nowhere else: the `village` tool description, the not-installed refusal and
the shipped skills read these (their tests pin the wiring, not the words). {name}, {description} and {link}
are filled from the reviewed catalog (_install_catalog.py), never from a tool argument or an upstream reply.

The "Then send /new" clauses are product's to drop once v2.1.5 (ov#410, an installed mini-app reaches an open
chat without /new) is on every box.
"""

# The lead's install rule, whole (L13329). The shipped `mini-apps` skill carries it.
RULE = ("If an app isn't installed, send the resident its install link (one tap). Never tell them to contact the "
        "team or organisers. You cannot install apps yourself; the resident's tap is the consent.")
# The same rule as the `village` tool description's last sentences, written there literally (R-DEON's proof
# literal-evals SCHEMA; a test pins them equal). It drops "the resident's tap is the consent": with it, the longer
# description lets ask_village outrank village for "people search" in Hermes's tool_search BM25
# (plugins/av-events/tests/test_ask_village_findable.py). Keep any rewrite at or under this length.
TOOL_RULE = ("If an app isn't installed, send the resident its install link (one tap). Never tell them to contact the "
             "team or organisers. You cannot install apps yourself.")

# The refusal's `instruction` when the catalog has a link this resident can open (product's text, verbatim).
NOT_INSTALLED = ("This app is not installed for this resident. Do not retry and do not send them to the team. Tell them "
                 "you cannot install it yourself and give the one-tap link below; until the box runs v2.1.5, add: then "
                 "send /new. Never show this code.")

# The refusal's `instruction` when no link can be given (an app outside the reviewed catalog, or one this resident
# cannot open in Mini-apps). Release's placeholder until product supplies the words.
NOT_OFFERED = ("This app is not available to this resident. Do not retry and do not send them to the team or the "
               "organisers. Say you cannot use it here and carry on without it. Never show this code.")

# The refusal's `instruction` when the app is installed but this agent's entry does not carry the operation yet.
# Release's placeholder until product supplies the words.
NOT_YET = ("This app is installed, but this action is not available on this agent yet. Do not retry now, do not send "
           "an install link and do not send them to the team or the organisers. Never show this code.")

# 1. The resident names an app that isn't installed.
NAMED = "I can't install apps myself, but you can in one tap: **{name}** — {description} {link} Then send /new and I'll know it."
# 2. A general ask ("install mini-apps", "what apps can you use?"): the intro, one LINE per app (unranked), the outro.
GENERAL_INTRO = "I can't install apps myself, but you can add any of these in one tap:"
LINE = "**{name}** — {description} {link}"
GENERAL_OUTRO = "Tap the ones you want; after each, send /new."
# 3. An action fails mid-task because its app isn't installed: name the app, never the error.
MID_TASK = "That needs **{name}**, which isn't installed yet. One tap: {link} Then send /new and ask me again."

# The shipped `mini-apps` skill (skills/mini-apps/SKILL.md, generated from these strings and the catalog by
# scripts/gen_install_catalog.py). SKILL_DESCRIPTION is its skills-index line.
SKILL_DESCRIPTION = ("Install or add mini-apps, what apps you can use, or an action that needs an app that isn't installed "
                     "(Rolodex comes with Gold Stars): give the resident that app's one-tap install link. You cannot install "
                     "apps yourself; the resident's tap is the consent. Never send them to the team or organisers.")
SKILL_OFFER = ("Offer only apps this resident can open in Mini-apps: the app ids in `$AV_MINI_APPS_OFFERED` (read it with "
               "`printenv AV_MINI_APPS_OFFERED`; comma-separated), and the `installUrl` and `installable` list in the "
               "`village` tool's `mini_app_not_installed` answer. Give each link exactly as written below or as the tool "
               "returned it; never build or change one. If the variable is unset or empty and the tool gave no link, say "
               "you can't add apps from here right now and carry on.")
NEVER = ("Never send them to the team or the organisers to install an app. Never say you installed it. Never show the "
         "error code, a tool name or any link other than the app's install link. Never promise it works in this chat "
         "before they send /new.")

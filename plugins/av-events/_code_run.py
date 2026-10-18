"""`code.run@1`: what an `execute_code` call's program could do, as closed codes (P10-P1).

The outer `execute_code` call already leaves as a `tool.call` (`_tools.py`): its
arguments' keyed hash, their length and a status, nothing about the program. Since
rc42 `execute_code` is outside the approval hook (CODE-RUN-GATE research, row 7), so
nothing records what the program reached for. This module adds one event per
`execute_code` call, built in `post_tool_call` (a pure observer: Hermes discards its
return) from values that call already carries, and nothing else:

* `code_hmac`, `code_bytes`: the program's keyed hash (`Collector.keyed_hash`, the
  tenant's own HMAC key, as `tool.call.args_hash`) and its UTF-8 byte length. Both
  null in `metadata` capture, as `tool.call` drops its hashes and lengths there, and
  when the call carried no string `code`.
* `status`, `error_type`: the same closed values `tool.call` sends.
* `tool_calls_made`: the int Hermes puts in the result, or null.
* `unavailable_tool_refusals`, `unavailable_tools`: how many
  `Tool '<x>' is not available in execute_code` refusals the result's text holds
  (Hermes's RPC allowlist answer, `tools/code_execution_rpc.py`), and the distinct
  `<x>` as a sorted list: a name only when `tool_categories.json` lists it, any other
  name as `other`.
* `risk_tags`: a sorted list from `RISK_TAGS`, a closed set, computed here from the
  program text by plain regex checks. A tag means the text *could* do the thing, not
  that it did: the checks are static, can over-fire (a comment, a co-occurrence) and
  can be evaded (string building). `gated_host` matches the hosts the plugin already
  knows (`gated_hosts`); no host ever leaves.
* `consent_scope`, `rules_version`, `category_version`: labels.

Never sent: the program, its output, a path, a host, an env name or value, any id
but the ones `tool.call` carries. Nothing here reads `.env` beyond the plugin's own
switch reader (`_core.env`), opens a file or touches the network.

Switches (`flag_on`, `scope`): `AV_EVENTS_CODE_RUN` (`1|true|yes|on`, `_core.env_flag_on`,
default off: off builds nothing) and `AV_EVENTS_CODE_RUN_SCOPE` (`all` |
`research_consented`; unset, blank or anything else is `all`). The scope rides in the
payload; the plugin sends the same event either way and agentvillage-data's worker
decides what it keeps (the `cron.run` precedent: an ops-allowlisted type kept without
research consent only when its payload says so).

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
from typing import Any, Callable, Iterable, Optional

from ._core import env, env_flag_on
from ._tools import TOOL_CATEGORIES, TOOL_CATEGORY_VERSION, _ERROR_TYPE, normalise_status

TYPE = "code.run"
TOOL_NAME = "execute_code"
FLAG = "AV_EVENTS_CODE_RUN"
SCOPE_ENV = "AV_EVENTS_CODE_RUN_SCOPE"
SCOPE_ALL = "all"
SCOPE_RESEARCH = "research_consented"
SCOPES = (SCOPE_ALL, SCOPE_RESEARCH)

#: Bumped whenever a tag's rule changes, so data can tell rule sets apart.
RULES_VERSION = "code_run_tags_v1"

#: The closed tag set, in the order the brief lists them.
RISK_TAGS = (
    "dotenv_path",
    "proc_environ",
    "os_environ",
    "subprocess",
    "socket_or_http_client",
    "hermes_home_write",
    "scripts_dir_write",
    "cron_write",
    "gated_host",
    "base64_or_eval",
)

#: Every count is capped here, so a pathological output cannot grow a field.
MAX_COUNT = 10000
#: `unavailable_tools`: at most this many names (data's `KERNEL_REFUSED_TOOLS_MAX`).
MAX_TOOL_NAMES = 16
OTHER_TOOL = "other"

#: Hermes's refusal for a tool outside the kernel's RPC allowlist
#: (`tools/code_execution_rpc.py`, `_handle_rpc_request`).
_REFUSAL = re.compile(r"Tool '([^'\n]{0,128})' is not available in execute_code")

# --------------------------------------------------------------------------
# Static tags. Every pattern is bounded (no nested or unbounded repeats before a
# literal), so a scan is linear in the program's length.
# --------------------------------------------------------------------------

_I = re.IGNORECASE

#: `.env` as a path segment (not `os.environ`, not `self.env`), or the dotenv package.
_DOTENV = re.compile(r"(?<![A-Za-z0-9_])\.env(?![A-Za-z0-9_])|\b(?:dotenv|load_dotenv|dotenv_values)\b")

#: `/proc/<pid>/environ` written out, the same built with a join, or psutil's `.environ()`.
_PROC_ENVIRON = re.compile(r"/proc/[^\s'\"]{0,64}environ\b|\.environ\s*\(\s*\)")
_PROC_LITERAL = re.compile(r"['\"]/proc/?['\"]")
_ENVIRON_LITERAL = re.compile(r"['\"]environ['\"]")

#: The process's own environment.
_OS_ENVIRON = re.compile(
    r"\bos\.environb?\b|\bgetenv\s*\(|\bposix\.environ\b"
    r"|\bfrom\s+os\s+import\s+[\w ,()]{0,200}\b(?:environ|environb|getenv)\b"
)

#: A child process.
_SUBPROCESS = re.compile(
    r"\bsubprocess\b"
    r"|\bos\.(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?|posix_spawnp?|fork|forkpty)\s*\("
    r"|\bpty\.spawn\b|\basyncio\.create_subprocess_(?:exec|shell)\b"
)

_NET_MODULES = (
    r"socket|ssl|urllib|urllib3|http|requests|httpx|aiohttp|websocket|websockets"
    r"|ftplib|smtplib|telnetlib|pycurl|xmlrpc"
)
#: A socket or an HTTP client: imported, imported dynamically, or used by name.
_NET = re.compile(
    rf"\bimport\s+[\w ,.]{{0,200}}?\b(?:{_NET_MODULES})\b"
    rf"|\bfrom\s+(?:{_NET_MODULES})\b"
    rf"|(?:__import__|import_module)\s*\(\s*['\"](?:{_NET_MODULES})\b"
    r"|\b(?:socket|urllib\.request|urllib3|requests|httpx|aiohttp|http\.client)\.[A-Za-z_]\w*"
    r"|\basyncio\.open_connection\b"
)

#: Something that writes, creates, moves or deletes a file.
_WRITE = re.compile(
    r"\bopen\s*\([^\n]{0,512}?,\s*(?:mode\s*=\s*)?['\"][rbt]*[wax+][rbt+]*['\"]"
    r"|\.(?:write_text|write_bytes|touch|symlink_to|hardlink_to|mkdir|unlink)\s*\("
    r"|\bshutil\.(?:copy|copy2|copyfile|copytree|copyfileobj|move|rmtree)\s*\("
    r"|\bos\.(?:rename|renames|replace|symlink|link|makedirs|mkdir|chmod|remove|unlink|truncate)\s*\("
    r"|\bO_(?:WRONLY|RDWR|CREAT|APPEND|TRUNC)\b"
    r"|(?<![>=<\-!])>>?\s*(?:~/|\$\{?HERMES_HOME|/[A-Za-z])"
    r"|\btee\s+(?:-a\s+)?[~$/]"
)
#: Where the write lands, matched anywhere in the program (a co-occurrence).
_HERMES_HOME = re.compile(r"HERMES_HOME|(?<![A-Za-z0-9_])\.hermes(?![A-Za-z0-9_])")
_SCRIPTS_DIR = re.compile(r"(?<![A-Za-z0-9_])scripts/|['\"]scripts['\"]")
_CRON = re.compile(r"(?<![A-Za-z0-9_])cron/|\bjobs\.json\b|\bcrontab\b|/etc/cron|['\"]cron['\"]")

#: Decoding or running text as code.
_BASE64_EVAL = re.compile(
    r"\bbase64\b|\b(?:b64decode|b32decode|b16decode|b85decode|a85decode|urlsafe_b64decode)\b"
    r"|(?<![\w.])(?:eval|exec|compile)\s*\(|\b__import__\s*\(|\bmarshal\.loads\b"
)

#: Hosts the program may not reach around the gate, whatever the env says.
#: Telegram's Bot API and OpenRouter are not in the plugin's env (the agent's own
#: keys reach them), so they are named here; the others are the plugin's own pins.
FIXED_GATED_HOSTS = ("index.network", "edgeos.world", "api.telegram.org", "openrouter.ai")
_HOSTNAME = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")


def flag_on() -> bool:
    """`AV_EVENTS_CODE_RUN`: the plugin's one on-switch reader. Unset, blank, `0`
    or anything not `1|true|yes|on` is off."""
    return env_flag_on(FLAG)


def scope() -> str:
    """`AV_EVENTS_CODE_RUN_SCOPE`: `research_consented` (`-` read as `_`), else `all`."""
    value = env(SCOPE_ENV).strip().lower().replace("-", "_")
    return value if value in SCOPES else SCOPE_ALL


def _host_of(url: Any) -> Optional[str]:
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        host = (urllib.parse.urlsplit(url.strip()).hostname or "").lower()
    except ValueError:
        return None
    return host if _HOSTNAME.match(host) else None


def gated_hosts() -> frozenset:
    """The fixed hosts, plus those the plugin already pins or reads for its own calls:
    EdgeOS's seed hosts and `EDGEOS_API_BASE` (`_edgeos`), the control plane's
    `CP_HOSTS` and `CONTROL_PLANE_URL` (`_pray`), Index's REST origin (`_record_intention.api_origin`).
    Each read is wrapped: a failure costs that host, never the event."""
    hosts = set(FIXED_GATED_HOSTS)
    try:
        from . import _edgeos

        hosts.update(h for h in _edgeos.ALLOWLIST.hosts if _HOSTNAME.match(h))
        # Process environment only, as `_edgeos._base_value` reads it.
        host = _host_of(os.environ.get("EDGEOS_API_BASE"))
        if host:
            hosts.add(host)
    except Exception:  # noqa: BLE001 - a host lost, not the event
        pass
    try:
        from . import _pray

        hosts.update(h for h in _pray.CP_HOSTS if _HOSTNAME.match(h))
        host = _host_of(env(_pray.URL_ENV))
        if host:
            hosts.add(host)
    except Exception:  # noqa: BLE001
        pass
    try:
        from . import _record_intention

        origin, _ = _record_intention.api_origin()
        host = _host_of(origin)
        if host:
            hosts.add(host)
    except Exception:  # noqa: BLE001
        pass
    return frozenset(hosts)


def _mentions_host(lowered: str, hosts: Iterable[str]) -> bool:
    """A host named as a whole host or a subdomain of it (`api.index.network` names
    `index.network`; `myindex.network` does not). One alternation, one linear scan."""
    names = sorted({h for h in hosts if isinstance(h, str) and _HOSTNAME.match(h)}, key=len, reverse=True)
    if not names:
        return False
    pattern = r"(?<![a-z0-9-])(?:" + "|".join(re.escape(h) for h in names) + r")(?![a-z0-9-])"
    return re.search(pattern, lowered) is not None


def risk_tags(code: str, hosts: Iterable[str] = ()) -> list[str]:
    """The sorted tags `code` carries; [] for empty code. Never raises on a str."""
    if not code:
        return []
    tags: set[str] = set()
    if _DOTENV.search(code):
        tags.add("dotenv_path")
    if _PROC_ENVIRON.search(code) or (_PROC_LITERAL.search(code) and _ENVIRON_LITERAL.search(code)):
        tags.add("proc_environ")
    if _OS_ENVIRON.search(code):
        tags.add("os_environ")
    if _SUBPROCESS.search(code):
        tags.add("subprocess")
    if _NET.search(code):
        tags.add("socket_or_http_client")
    if _WRITE.search(code):
        if _HERMES_HOME.search(code):
            tags.add("hermes_home_write")
        if _SCRIPTS_DIR.search(code):
            tags.add("scripts_dir_write")
        if _CRON.search(code):
            tags.add("cron_write")
    if _mentions_host(code.lower(), hosts):
        tags.add("gated_host")
    if _BASE64_EVAL.search(code):
        tags.add("base64_or_eval")
    return sorted(tags)


def _result_texts(result: Any) -> tuple[list[str], Optional[dict]]:
    """(the texts to scan for refusals, the parsed result dict or None).

    Hermes returns JSON: `output` (stdout, with stderr and any traceback joined in)
    and, on a failure, `error`. Those two are scanned once each. A result that is not
    a JSON object is scanned whole, as a string."""
    if isinstance(result, dict):
        parsed: Optional[dict] = result
    elif isinstance(result, str):
        try:
            loaded = json.loads(result)
        except (ValueError, RecursionError):
            loaded = None
        parsed = loaded if isinstance(loaded, dict) else None
        if parsed is None:
            return [result], None
    else:
        return [], None
    texts = [parsed[k] for k in ("output", "error") if isinstance(parsed.get(k), str)]
    return texts, parsed


def refusals(texts: Iterable[str]) -> tuple[int, list[str]]:
    """(count, sorted distinct names) of the RPC refusals in `texts`. A name leaves
    only when `tool_categories.json` lists it; any other is `other`."""
    count = 0
    names: set[str] = set()
    for text in texts:
        for match in _REFUSAL.finditer(text):
            count += 1
            name = match.group(1)
            names.add(name if name in TOOL_CATEGORIES else OTHER_TOOL)
            if count >= MAX_COUNT:
                break
        if count >= MAX_COUNT:
            break
    ordered = sorted(names)
    if len(ordered) > MAX_TOOL_NAMES:
        keep = [n for n in ordered if n != OTHER_TOOL][: MAX_TOOL_NAMES - 1]
        ordered = sorted(keep + [OTHER_TOOL])
    return min(count, MAX_COUNT), ordered


def _bounded_count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= MAX_COUNT else None


def code_of(args: Any) -> Optional[str]:
    """The program as Hermes runs it: `args["code"]` when it is a string."""
    if isinstance(args, dict):
        code = args.get("code")
        return code if isinstance(code, str) else None
    return None


def code_run_payload(
    args: Any,
    result: Any,
    status: Any,
    error_type: Any,
    capture: str,
    hasher: Callable[[str], Optional[str]],
    consent_scope: str,
    hosts: Iterable[str] = (),
) -> dict:
    """`code.run@1`: every key always present, in this order, null when unknown."""
    code = code_of(args)
    texts, parsed = _result_texts(result)
    refused, refused_names = refusals(texts)
    raw_error = error_type if isinstance(error_type, str) else None
    keyed = capture != "metadata" and code is not None
    return {
        "consent_scope": consent_scope if consent_scope in SCOPES else SCOPE_ALL,
        "code_hmac": hasher(code) if keyed else None,
        "code_bytes": len(code.encode("utf-8", errors="surrogatepass")) if keyed else None,
        "status": normalise_status(status),
        "error_type": raw_error if raw_error and _ERROR_TYPE.match(raw_error) else None,
        "tool_calls_made": _bounded_count(parsed.get("tool_calls_made")) if parsed is not None else None,
        "unavailable_tool_refusals": refused,
        "unavailable_tools": refused_names,
        "risk_tags": risk_tags(code or "", hosts),
        "rules_version": RULES_VERSION,
        "category_version": TOOL_CATEGORY_VERSION,
    }


#: The payload's keys, in order (the contract's field list; a test holds them together).
FIELD_NAMES = (
    "consent_scope",
    "code_hmac",
    "code_bytes",
    "status",
    "error_type",
    "tool_calls_made",
    "unavailable_tool_refusals",
    "unavailable_tools",
    "risk_tags",
    "rules_version",
    "category_version",
)

__all__ = [
    "FIELD_NAMES",
    "FLAG",
    "RISK_TAGS",
    "RULES_VERSION",
    "SCOPE_ENV",
    "SCOPES",
    "TOOL_NAME",
    "TYPE",
    "code_run_payload",
    "flag_on",
    "gated_hosts",
    "refusals",
    "risk_tags",
    "scope",
]

"""Panel settings: config.json (edited from the panel's settings dialog), overridden by environment variables when set.

usage: config.py get <name>   prints the value (booleans as 1/0), for shell scripts
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from language import DEFAULT as DEFAULT_LANGUAGE, Language  # noqa: E402

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
DEFAULTS = {"model": "opus", "lang": DEFAULT_LANGUAGE.code, "flow_auto": True, "qa_auto": True, "panel_auto": True}
ENV = {"model": "CLAUDE_FLOW_MODEL", "lang": "CLAUDE_PANEL_LANG", "flow_auto": "CLAUDE_FLOW_AUTO",
       "qa_auto": "CLAUDE_QA_AUTO", "panel_auto": "CLAUDE_PANEL_AUTO"}
MODELS = ("opus", "sonnet", "haiku")
MODEL_RE = re.compile(r"^(opus|sonnet|haiku|claude-[a-z0-9.-]+)$")


def _valid(name, value):
    if name == "model":
        return isinstance(value, str) and bool(MODEL_RE.match(value))
    if name == "lang":
        return Language.from_code(value) is not None and len(value) == 2
    return isinstance(value, bool)


def _from_env(name):
    raw = os.environ.get(ENV[name])
    if raw is None or raw == "":
        return None
    value = raw[:2].lower() if name == "lang" else raw if name == "model" else raw != "0"
    return value if _valid(name, value) else None


def _saved():
    try:
        with open(PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        return {k: v for k, v in data.items() if k in DEFAULTS and _valid(k, v)}
    except (OSError, ValueError, AttributeError):
        return {}


def load():
    """Effective settings and the names pinned by environment variables."""
    values, locked = {**DEFAULTS, **_saved()}, []
    for name in DEFAULTS:
        env_value = _from_env(name)
        if env_value is not None:
            values[name] = env_value
            locked.append(name)
    return values, locked


def get(name):
    return load()[0][name]


def save(update):
    saved = _saved()
    for name, value in update.items():
        if name not in DEFAULTS or not _valid(name, value):
            raise ValueError(f"invalid setting: {name}={value!r}")
        saved[name] = value
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(saved, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, PATH)
    return load()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "get" and sys.argv[2] in DEFAULTS:
        value = get(sys.argv[2])
        print(int(value) if isinstance(value, bool) else value)
    else:
        sys.exit(__doc__)

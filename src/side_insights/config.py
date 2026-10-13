"""Panel settings, stored in config.json and edited from the panel's settings dialog.

usage: python3 -m side_insights config get <name> [pane]   prints the value (booleans as 1/0), for shell scripts
"""
import os
import re
import sys
import threading
from enum import Enum

from side_insights.paths import DATA, atomic_write_json, read_json
from side_insights.language import DEFAULT as DEFAULT_LANGUAGE, Language, system_language

PATH = os.path.join(DATA, "config.json")
MODELS = ("opus", "sonnet", "haiku")
AUTO_THEME = "auto"
THEMES = (AUTO_THEME, "dark", "light")
_MODEL_RE = re.compile(r"^(%s|claude-[a-z0-9.-]+)$" % "|".join(MODELS))
_SAVE_LOCK = threading.Lock()


class Setting(Enum):
    MODEL = ("model", "opus")
    LANG = ("lang", DEFAULT_LANGUAGE.code)
    FLOW_AUTO = ("flow_auto", True)
    QA_AUTO = ("qa_auto", True)
    PANEL_AUTO = ("panel_auto", False)
    KOREAN_KEYS = ("korean_keys", False)
    THEME = ("theme", AUTO_THEME)

    def __init__(self, key, default):
        self.key = key
        self.default = default

    def valid(self, value):
        if self is Setting.MODEL:
            return isinstance(value, str) and bool(_MODEL_RE.match(value))
        if self is Setting.LANG:
            return Language.from_code(value) is not None
        if self is Setting.THEME:
            return value in THEMES
        return isinstance(value, bool)


_BY_KEY = {s.key: s for s in Setting}
_PANES = "panes"


def _saved():
    saved = read_json(PATH, {})
    return saved if isinstance(saved, dict) else {}


def _valid_only(values):
    return {k: v for k, v in (values or {}).items() if k in _BY_KEY and _BY_KEY[k].valid(v)} if isinstance(values, dict) else {}


def overrides(pane):
    panes = _saved().get(_PANES)
    return _valid_only(panes.get(pane)) if pane and isinstance(panes, dict) else {}


def load(pane=None):
    saved = _saved()
    defaults = {**{s.key: s.default for s in Setting}, Setting.LANG.key: system_language().code}
    return {**defaults, **_valid_only(saved), **overrides(pane)}


def get(name, pane=None):
    return load(pane)[name]


def save(update, pane=None):
    if not isinstance(update, dict):
        raise ValueError("settings must be an object")
    for name, value in update.items():
        if name not in _BY_KEY or not (_BY_KEY[name].valid(value) or (pane and value is None)):
            raise ValueError(f"invalid setting: {name}={value!r}")
    with _SAVE_LOCK:
        saved = _saved()
        panes = saved.get(_PANES)
        data = {**_valid_only(saved), _PANES: dict(panes) if isinstance(panes, dict) else {}}
        if pane:
            pane_values = {**overrides(pane), **update}
            pane_values = {k: v for k, v in pane_values.items() if v is not None}
            if pane_values:
                data[_PANES][pane] = pane_values
            else:
                data[_PANES].pop(pane, None)
        else:
            data.update(update)
        atomic_write_json(PATH, data)
    return load(pane)


def payload(pane=None):
    return {"global": load(), "pane": overrides(pane), "effective": load(pane), "models": list(MODELS), "themes": list(THEMES),
            "langs": [{"code": lang.code, "label": lang.label} for lang in Language]}


if __name__ == "__main__":
    if len(sys.argv) in (3, 4) and sys.argv[1] == "get" and sys.argv[2] in _BY_KEY:
        value = get(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
        print(int(value) if isinstance(value, bool) else value)
    else:
        sys.exit(__doc__)

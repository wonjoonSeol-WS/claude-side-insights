"""Panel settings, stored in config.json and edited from the panel's settings dialog.

usage: python3 -m side_insights config get <name> [pane]   prints the value (booleans as 1/0), for shell scripts
       python3 -m side_insights config opens-panel <pane>   prints 1 when a session start there opens the panel
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
OPENED = "opened"
ALL_SESSIONS = "all"
ANALYZE = (OPENED, ALL_SESSIONS)
QA_BATCHES = (5, 10, 20, 30)
MODEL_QA_BATCH = {"opus": 20, "sonnet": 10, "haiku": 5}
_MODEL_RE = re.compile(r"^(%s|claude-[a-z0-9.-]+)$" % "|".join(MODELS))
_SAVE_LOCK = threading.Lock()


class Setting(Enum):
    MODEL = ("model", "opus")
    LANG = ("lang", DEFAULT_LANGUAGE.code)
    FLOW_AUTO = ("flow_auto", True)
    QA_AUTO = ("qa_auto", True)
    ANALYZE = ("analyze", OPENED)
    QA_BATCH = ("qa_batch", 20)
    ENABLED = ("enabled", False)
    PANEL_AUTO = ("panel_auto", True)
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
        if self is Setting.ANALYZE:
            return value in ANALYZE
        if self is Setting.QA_BATCH:
            return type(value) is int and value in QA_BATCHES
        return isinstance(value, bool)


_BY_KEY = {s.key: s for s in Setting}
_PANES = "panes"


def _saved():
    saved = read_json(PATH, {})
    return saved if isinstance(saved, dict) else {}


_PANE_ONLY = frozenset({Setting.ENABLED.key})
_FAMILY = re.compile(r"(?:^|claude-)(opus|sonnet|haiku)(?:$|-)")


def _valid_only(values, keys=None):
    if not isinstance(values, dict):
        return {}
    allowed = keys if keys is not None else set(_BY_KEY) - _PANE_ONLY
    return {k: v for k, v in values.items() if k in allowed and _BY_KEY[k].valid(v)}


def overrides(pane):
    """What a panel holds of its own: only whether it is analyzed. Every other setting is shared."""
    panes = _saved().get(_PANES)
    return _valid_only(panes.get(pane), _PANE_ONLY) if pane and isinstance(panes, dict) else {}


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
        if name not in _BY_KEY or (name in _PANE_ONLY) != bool(pane) or not (_BY_KEY[name].valid(value) or (pane and value is None)):
            raise ValueError(f"invalid setting: {name}={value!r}")
    model = update.get(Setting.MODEL.key)
    family = _FAMILY.search(str(model or ""))
    if family and Setting.QA_BATCH.key not in update and model != load()[Setting.MODEL.key]:
        update = {**update, Setting.QA_BATCH.key: MODEL_QA_BATCH[family.group(1)]}
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


def runs(kind, pane=None):
    """Whether the end of a turn starts this analysis ("flow" or "qa") for the pane: switched on, and the pane opened or all sessions."""
    shared, settings = load(), load(pane)
    return bool(shared[f"{kind}_auto"]) and (shared["analyze"] == ALL_SESSIONS or bool(settings["enabled"]))


def opens_panel(pane):
    """Whether a session start in this pane opens the panel: switched on, and the pane analyzed or all sessions."""
    shared = load()
    return bool(shared[Setting.PANEL_AUTO.key]) and (shared["analyze"] == ALL_SESSIONS or bool(load(pane)["enabled"]))


def payload(pane=None):
    return {"global": load(), "pane": overrides(pane), "effective": load(pane), "models": list(MODELS), "themes": list(THEMES),
            "analyze": list(ANALYZE), "qa_batches": list(QA_BATCHES),
            "langs": [{"code": lang.code, "label": lang.label} for lang in Language]}


if __name__ == "__main__":
    if len(sys.argv) in (3, 4) and sys.argv[1] == "get" and sys.argv[2] in _BY_KEY:
        value = get(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
        print(int(value) if isinstance(value, bool) else value)
    elif len(sys.argv) == 3 and sys.argv[1] == "opens-panel":
        print(int(opens_panel(sys.argv[2])))
    else:
        sys.exit(__doc__)

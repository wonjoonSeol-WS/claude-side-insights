"""Supported languages: code, display label and the name used to ask the model for that language."""
import functools
import os
import re
import subprocess
import sys
from enum import Enum


class Language(Enum):
    KO = ("ko", "한국어", "Korean")
    EN = ("en", "English", "English")
    JA = ("ja", "日本語", "Japanese")

    def __init__(self, code, label, prompt_name):
        self.code = code
        self.label = label
        self.prompt_name = prompt_name

    @classmethod
    def from_code(cls, code, default=None):
        return next((lang for lang in cls if lang.code == code), default)


DEFAULT = Language.EN

_LOCALE_ENV = ("LC_ALL", "LC_MESSAGES", "LANG")
_NO_PREFERENCE = ("c", "posix")
_LANG_RE = re.compile(r"^(ko|ja)([_.@-]|$)")
_APPLE_LANGUAGES = ["/usr/bin/defaults", "read", "-g", "AppleLanguages"]
_DETECT_TIMEOUT = 2


def _clean(value):
    return (value or "").strip().strip('",()').lower()


def _match(value):
    found = _LANG_RE.match(_clean(value))
    return Language.from_code(found.group(1)) if found else None


def _apple_first_language():
    try:
        out = subprocess.run(_APPLE_LANGUAGES, capture_output=True, text=True, timeout=_DETECT_TIMEOUT).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    return next((_clean(line) for line in out.splitlines() if _clean(line)), "")


def _locale_preference():
    value = next((_clean(os.environ.get(name)) for name in _LOCALE_ENV if _clean(os.environ.get(name))), "")
    return "" if re.split(r"[.@]", value)[0] in _NO_PREFERENCE else value


@functools.lru_cache(maxsize=1)
def system_language():
    preference = _locale_preference()
    if preference:
        return _match(preference) or DEFAULT
    if sys.platform == "darwin":
        return _match(_apple_first_language()) or DEFAULT
    return DEFAULT

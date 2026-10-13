"""Supported languages: code, display label and the name used to ask the model for that language."""
import functools
import os
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
_APPLE_LANGUAGES = ["/usr/bin/defaults", "read", "-g", "AppleLanguages"]
_DETECT_TIMEOUT = 2


def _match(value):
    value = (value or "").strip().strip('",()').lower()
    return next((lang for lang in (Language.KO, Language.JA) if value.startswith(lang.code)), None)


def _apple_first_language():
    try:
        out = subprocess.run(_APPLE_LANGUAGES, capture_output=True, text=True, timeout=_DETECT_TIMEOUT).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    return next((line.strip().strip('",()') for line in out.splitlines() if line.strip().strip('",()')), "")


@functools.lru_cache(maxsize=1)
def system_language():
    """Korean or Japanese when the locale or, on macOS, the first preferred language says so; English otherwise."""
    for name in _LOCALE_ENV:
        found = _match(os.environ.get(name))
        if found:
            return found
    if sys.platform == "darwin":
        return _match(_apple_first_language()) or DEFAULT
    return DEFAULT

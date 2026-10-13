"""Supported languages: code -> display label, name used in analysis prompts, locale file."""
import os
from enum import Enum

LOCALES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "locales")


class Language(Enum):
    KO = ("ko", "한국어", "한국어 (Korean)")
    EN = ("en", "English", "English")
    JA = ("ja", "日本語", "日本語 (Japanese)")

    def __init__(self, code, label, prompt_name):
        self.code = code
        self.label = label
        self.prompt_name = prompt_name

    @property
    def locale_path(self):
        return os.path.join(LOCALES_DIR, f"{self.code}.json")

    @classmethod
    def from_code(cls, code, default=None):
        value = str(code or "")[:2].lower()
        return next((lang for lang in cls if lang.code == value), default)


DEFAULT = Language.EN

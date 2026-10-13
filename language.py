"""Supported languages: code, display label and the name used to ask the model for that language."""
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

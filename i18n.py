"""Translations from locales/<code>.json, shared with the web UI. The active language is the `lang` setting."""
import json
import os
import sys
from functools import lru_cache

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
from language import DEFAULT, Language  # noqa: E402


def current():
    return Language.from_code(config.get("lang"), DEFAULT)


@lru_cache(maxsize=None)
def messages(language):
    with open(language.locale_path, encoding="utf-8") as fh:
        return json.load(fh)


def t(key, *args):
    text = messages(current()).get(key) or messages(DEFAULT).get(key) or key
    return text.format(*args)


def output_language_instruction():
    name = current().prompt_name
    return (f"\n\n출력 언어: 모든 텍스트 필드(title, summary, explanation, question, answer 등)는 {name} 로 쓴다. "
            f"Write every text field in {name}. 코드 발췌와 식별자는 원문 그대로 둔다.")

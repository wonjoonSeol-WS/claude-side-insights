"""Translations from locales/<code>.json, shared with the web UI. The language is the `lang` setting of the pane."""
import os
from functools import lru_cache

from side_insights import config
from side_insights.paths import PACKAGE_DIR, read_json
from side_insights.language import DEFAULT, Language


def current(pane=None):
    return Language.from_code(config.get("lang", pane), DEFAULT)


@lru_cache(maxsize=None)
def _locale_path(language):
    return os.path.join(PACKAGE_DIR, "locales", f"{language.code}.json")


def messages(language):
    return read_json(_locale_path(language), {})


def t(key, *args, pane=None):
    text = messages(current(pane)).get(key) or messages(DEFAULT).get(key) or key
    try:
        return text.format(*args)
    except (IndexError, KeyError, ValueError):
        return text


def language_instruction(pane, keep=""):
    kept = f" Keep {keep} exactly in the user's own words and language." if keep else ""
    return (f"\n\nWrite every text field in {current(pane).prompt_name}.{kept}"
            " Keep code excerpts, identifiers, file names and commands as they are.")


if __name__ == "__main__":
    import sys

    from side_insights.paths import pane_key

    if len(sys.argv) < 2:
        sys.exit("usage: python3 -m side_insights say <message-key> [args...]")
    print(t(sys.argv[1], *sys.argv[2:], pane=pane_key() or None))

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import locale_fixture  # noqa: E402

MOD = os.path.join(locale_fixture.ROOT, "hooks", "mod")
KEY = re.compile(r"^[a-z][a-z0-9_]*$")
QUOTED = re.compile(r"'([^'\n]*)'")
TABLE_ROW = re.compile(r"\[\s*'[^'\n]*',\s*'([^'\n]*)'\s*\]")
LABEL_TABLE = re.compile(r"\b[A-Z_]+_LABEL\b[^=]*=\s*\{([^}]*)\}")


KEY_TABLE = re.compile(r"\[string, string\]\[\]>? = ([\[{])")
PAIRS = {"(": ")", "[": "]", "{": "}"}


def balanced(source, start, open_char):
    depth, i, first_comma = 1, start, None
    while depth and i < len(source):
        ch = source[i]
        if ch == open_char:
            depth += 1
        elif ch == PAIRS[open_char]:
            depth -= 1
        elif ch == "," and depth == 1 and first_comma is None and open_char == "(":
            first_comma = i
        i += 1
    return source[start:first_comma if first_comma is not None else i - 1]


def calls(source, name):
    return [balanced(source, found.end(), "(") for found in re.finditer(r"(?<![A-Za-z0-9_.])" + name + r"\(", source)]


def static_keys():
    keys = set()
    for name in sorted(os.listdir(MOD)):
        with open(os.path.join(MOD, name), encoding="utf-8") as fh:
            source = fh.read()
        for args in calls(source, "t") + calls(source, r"c\.t"):
            keys.update(k for k in QUOTED.findall(args) if KEY.match(k))
        for table in KEY_TABLE.finditer(source):
            keys.update(TABLE_ROW.findall(balanced(source, table.end(), table.group(1))))
        for table in LABEL_TABLE.findall(source):
            keys.update(QUOTED.findall(table))
    return keys


class LocaleTest(unittest.TestCase):
    def test_the_mod_test_fixture_matches_the_locale_files(self):
        with open(locale_fixture.TARGET, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), locale_fixture.render(), "run /usr/bin/python3 tests/locale_fixture.py")

    def test_every_key_the_mod_names_is_in_every_language(self):
        keys = static_keys()
        self.assertIn("mod_band_hint", keys)
        self.assertIn("mod_k_close_diff", keys)
        self.assertIn("mod_help_close", keys)
        for lang in locale_fixture.LANGS:
            missing = sorted(keys - set(locale_fixture.load(lang)))
            self.assertEqual(missing, [], lang)

    def test_every_language_has_the_same_keys(self):
        en = set(locale_fixture.load("en"))
        for lang in locale_fixture.LANGS:
            self.assertEqual(set(locale_fixture.load(lang)) ^ en, set(), lang)


if __name__ == "__main__":
    unittest.main()

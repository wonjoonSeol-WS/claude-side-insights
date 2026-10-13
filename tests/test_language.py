import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights import language  # noqa: E402
from side_insights.language import Language  # noqa: E402


class SystemLanguageTest(unittest.TestCase):
    def detect(self, env, apple="", platform="darwin"):
        language.system_language.cache_clear()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(language, "_apple_first_language", return_value=apple) as apple_call, \
                mock.patch.object(language.sys, "platform", platform):
            found = language.system_language()
        language.system_language.cache_clear()
        return found, apple_call.called

    def test_the_first_set_locale_variable_decides(self):
        self.assertEqual(self.detect({"LC_ALL": "en_US.UTF-8", "LANG": "ko_KR.UTF-8"}, apple="ko-KR"), (Language.EN, False))
        self.assertEqual(self.detect({"LC_MESSAGES": "ja_JP.UTF-8", "LANG": "ko_KR.UTF-8"}, apple="en-US"), (Language.JA, False))
        self.assertEqual(self.detect({"LANG": "ko_KR.UTF-8"}, apple="ja-JP"), (Language.KO, False))

    def test_another_language_means_english_even_when_macos_prefers_korean(self):
        self.assertEqual(self.detect({"LANG": "fr_FR.UTF-8"}, apple="ko-KR"), (Language.EN, False))

    def test_c_posix_or_empty_fall_through_to_macos(self):
        for env in ({}, {"LANG": ""}, {"LC_ALL": "C"}, {"LC_ALL": "C.UTF-8", "LANG": "en_US.UTF-8"}, {"LANG": "POSIX"}):
            self.assertEqual(self.detect(env, apple="ja-JP"), (Language.JA, True), env)
        self.assertEqual(self.detect({"LANG": "C"}, apple="en-GB"), (Language.EN, True))

    def test_no_preference_off_macos_is_english(self):
        self.assertEqual(self.detect({"LANG": "C"}, apple="ko-KR", platform="linux"), (Language.EN, False))

    def test_only_a_whole_language_code_matches(self):
        self.assertEqual(self.detect({"LANG": "kok_IN.UTF-8"}, apple="ko-KR"), (Language.EN, False))
        self.assertEqual(self.detect({"LANG": "ko"}), (Language.KO, False))
        self.assertEqual(self.detect({"LANG": "ja@x"}), (Language.JA, False))
        self.assertEqual(self.detect({}, apple='"ko-Kore-KR",'), (Language.KO, True))


if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.live import client  # noqa: E402


def fake_server(pane=None, **shared):
    sent = []

    def call(method, path, body=None, params=None):
        sent.append((method, path, body, params))
        if method == "GET":
            return {"pane": pane or {}, "global": {"analyze": "opened", "qa_auto": True, "flow_auto": True, **shared}}
        if "regen" in path and params.get("target") == "qa":
            raise client.ServerError("err_running")
        return {"ok": True}

    return sent, mock.patch.object(client, "call", call)


def posted(sent):
    return [(path, body, params) for method, path, body, params in sent if method == "POST"]


class EnableTest(unittest.TestCase):
    def test_an_off_pane_is_switched_on_and_both_checks_start(self):
        sent, patch = fake_server({"enabled": False})
        with patch:
            client.enable("p1")
        self.assertEqual(posted(sent), [
            ("/api/config", {"enabled": True}, {"pane": "p1"}),
            ("/api/p1/regen", None, {"target": "qa"}),
            ("/api/p1/regen", None, {"target": "flow", "new": "1"}),
        ])

    def test_a_pane_already_on_is_left_alone(self):
        sent, patch = fake_server({"enabled": True})
        with patch:
            client.enable("p1")
        self.assertEqual(posted(sent), [])

    def test_only_the_checks_switched_on_start(self):
        sent, patch = fake_server(qa_auto=False)
        with patch:
            client.enable("p1")
        self.assertEqual([p for _, _, p in posted(sent)], [{"pane": "p1"}, {"target": "flow", "new": "1"}])

    def test_all_sessions_starts_no_check_since_the_hooks_run_them(self):
        sent, patch = fake_server(analyze="all")
        with patch:
            client.enable("p1")
        self.assertEqual(posted(sent), [("/api/config", {"enabled": True}, {"pane": "p1"})])


if __name__ == "__main__":
    unittest.main()

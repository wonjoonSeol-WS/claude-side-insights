"""Questions the user has sent that the Q&A check has not judged yet, read from the transcript as it grows."""
import json
import os
import statistics
import threading

from side_insights.transcript import LOCAL_COMMANDS, is_prompt, prompt_text, queued_prompt

DEFAULT_ETA_SECONDS = 40
ETA_SAMPLES = 5
TEXT_LIMIT = 300


class Waiting:
    def __init__(self):
        self.lock = threading.Lock()
        self._reset(None)

    def _reset(self, path):
        self.path, self.pos, self.buf = path, 0, b""
        self.count, self.index, self.prompts = 0, {}, []

    def _read(self, path):
        try:
            size = os.path.getsize(path)
        except OSError:
            return
        if path != self.path or size < self.pos:
            self._reset(path)
        if size == self.pos:
            return
        with open(path, "rb") as fh:
            fh.seek(self.pos)
            self.buf += fh.read()
            self.pos = fh.tell()
        *lines, self.buf = self.buf.split(b"\n")
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict):
                self._add(entry)

    def _add(self, entry):
        self.count += 1
        if entry.get("uuid"):
            self.index[entry["uuid"]] = self.count
        if is_prompt(entry):
            text = prompt_text(entry)
            if text.split(" ", 1)[0] not in LOCAL_COMMANDS:
                self.prompts.append({"at": self.count, "ts": entry.get("timestamp"), "text": text[:TEXT_LIMIT], "mid_turn": False})
        else:
            text = queued_prompt(entry)
            if text:
                self.prompts.append({"at": self.count, "ts": entry.get("timestamp"), "text": text[:TEXT_LIMIT], "mid_turn": True})

    def since(self, path, cursor):
        """Prompts after the entry `cursor`; without a cursor, from the last typed prompt on."""
        if not path:
            return []
        with self.lock:
            self._read(path)
            if cursor in self.index:
                start = self.index[cursor]
            else:
                typed = [p["at"] for p in self.prompts if not p["mid_turn"]]
                start = typed[-1] - 1 if typed else 0
            return [{k: v for k, v in p.items() if k != "at"} for p in self.prompts if p["at"] > start]


def eta_seconds(records):
    """Typical time from the end of a turn to its Q&A result, from the latest checks."""
    seconds = [r["seconds"] for r in records if isinstance(r.get("seconds"), (int, float))][:ETA_SAMPLES]
    return round(statistics.median(seconds)) if seconds else DEFAULT_ETA_SECONDS

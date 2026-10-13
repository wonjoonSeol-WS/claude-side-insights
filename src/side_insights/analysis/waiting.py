"""Questions the user has sent that the Q&A check has not judged yet, read from the transcript as it grows."""
import json
import os
import statistics
import threading

from side_insights.transcript import is_local_command, is_local_output, is_prompt, prompt_text, queued_prompt

DEFAULT_ETA_SECONDS = 40
ETA_SAMPLES = 5
MAX_ETA_SECONDS = 600
TEXT_LIMIT = 300


class Waiting:
    def __init__(self):
        self.lock = threading.Lock()
        self._reset(None)

    def _reset(self, path):
        self.path, self.pos, self.buf = path, 0, b""
        self.count, self.index, self.prompts, self.command = 0, {}, [], None

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
        if self.command is not None and is_local_output(entry):
            self.prompts.remove(self.command)
        self.command = None
        if is_prompt(entry) and not is_local_command(entry):
            self._prompt(entry, prompt_text(entry), mid_turn=False)
            if entry.get("message") and "<command-name>" in str(entry["message"].get("content")):
                self.command = self.prompts[-1]
        elif queued_prompt(entry):
            self._prompt(entry, queued_prompt(entry), mid_turn=True)

    def _prompt(self, entry, text, mid_turn):
        self.prompts.append({"at": self.count, "ts": entry.get("timestamp"), "text": text[:TEXT_LIMIT], "mid_turn": mid_turn})

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
    seconds = [r["seconds"] for r in records
               if isinstance(r.get("seconds"), (int, float)) and not isinstance(r["seconds"], bool) and 0 < r["seconds"] < MAX_ETA_SECONDS]
    seconds = seconds[:ETA_SAMPLES]
    return round(statistics.median(seconds)) if seconds else DEFAULT_ETA_SECONDS

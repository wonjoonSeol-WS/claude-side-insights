"""Values stored in flow and Q&A records, shared by the analyses and both panels."""
import enum


class RecordStatus(str, enum.Enum):
    OK = "ok"
    ERROR = "error"


class Source(str, enum.Enum):
    PROMPT = "prompt"
    MID_TURN = "mid-turn"


class StepKind(str, enum.Enum):
    INPUT = "input"
    LOGIC = "logic"
    EXTERNAL = "external"
    STORAGE = "storage"
    OUTPUT = "output"
    CONFIG = "config"
    TEST = "test"

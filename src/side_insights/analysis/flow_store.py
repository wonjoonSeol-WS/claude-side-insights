"""Flow records written by analysis.flow, newest first."""
import os

from side_insights.paths import DATA, json_files, read_json


def flow_dir(pane):
    return os.path.join(DATA, "flows", pane)


def pending_path(pane):
    return os.path.join(flow_dir(pane), "pending")


def record_path(pane, flow_id):
    return os.path.join(flow_dir(pane), f"{flow_id}.json")


def latest(pane):
    """The newest flow record, reading only as many files as it takes to find one."""
    for path in sorted(json_files(flow_dir(pane)), reverse=True):
        rec = read_json(path)
        if isinstance(rec, dict) and rec.get("id"):
            return rec
    return None


def records(pane):
    found = []
    for path in sorted(json_files(flow_dir(pane)), reverse=True):
        rec = read_json(path)
        if isinstance(rec, dict) and rec.get("id"):
            found.append(rec)
    return found

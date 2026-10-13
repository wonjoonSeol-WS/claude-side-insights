"""The three tabs of the terminal panel, each built as a list of screen lines."""
import os
import time

from side_insights.analysis import flow_store, qa_store
from side_insights.analysis.runner import Pending
from side_insights.analysis.waiting import Waiting, eta_seconds
from side_insights.i18n import t
from side_insights.live.activity import ERR, OK, RUN, tool_label
from side_insights.live.term import (BLUE, CODE_BG, FAINT, GREEN, HIGHLIGHT_BG, LINE, MUTED, ORANGE, PURPLE, RED,
                                     SELECTED_BG, TEAL, TEXT, YELLOW, badge, bg, box, bullets, fit, fit_left, key_cap,
                                     paint, pad, rule, styled, tint, visible_width, width)
from side_insights.paths import EDIT_TOOLS

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
CAT = "ᓚᘏᗢ"
TRACK = 14
BAR = 16
CODE_LINES = 12
MAX_FILES = 30
WIDE_COLS = 110
GAP = 2
NAME_MIN, NAME_MAX = 6, 14
STATUS_COLOR = {qa_store.Status.ANSWERED.value: GREEN, qa_store.Status.PARTIAL.value: ORANGE,
                qa_store.Status.UNANSWERED.value: RED}
KIND_COLOR = {"input": MUTED, "logic": BLUE, "external": PURPLE, "storage": GREEN, "output": PURPLE,
              "config": ORANGE, "test": TEAL}
WAITING = Waiting()


def clock(ts, seconds=False):
    return time.strftime("%H:%M:%S" if seconds else "%H:%M", time.localtime(ts)) if ts else "--:--"


def fmt_secs(seconds):
    if seconds < 1:
        return f"{int(seconds * 1000)}ms"
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"


def progress(done, total, color, cols=BAR):
    filled = round(cols * done / total) if total else 0
    return paint("━" * filled, color) + paint("━" * (cols - filled), LINE)


def cat(busy, tick):
    if not busy:
        return paint(CAT, MUTED) + paint(" zZ", FAINT)
    spot = tick % TRACK
    return paint("·" * spot, FAINT) + paint(CAT, ORANGE, bold=True) + paint("·" * (TRACK - spot), FAINT)


def header(tab_keys, current, st, tick, cols):
    pane = st.pane
    tabs = " ".join(paint(f" {key} {t('mode_' + tab.value, pane=pane)} ", TEXT if tab == current else MUTED,
                          tint(BLUE, 0.55) if tab == current else tint(LINE, 0.6), bold=tab == current)
                    for key, tab in tab_keys.items())
    where = os.path.basename((st.cwd or "").rstrip("/")) or "-"
    status = paint(f"{SPINNER[tick % len(SPINNER)]} {t('busy', pane=pane)}", ORANGE) if st.busy \
        else paint(f"○ {t('idle', pane=pane)}", FAINT)
    return [f"{tabs}  {cat(st.busy, tick)}", f"{status}  {paint(fit(where + '  /  ' + (st.sid or '-')[:8], cols - 14).rstrip(), FAINT)}", ""]


def footer(pane, cols):
    keys = [("1 2 3", "term_k_tabs"), ("←→", "term_k_steps"), ("↑↓", "term_k_scroll"), ("o", "term_k_open"), ("q", "term_k_quit")]
    line = paint(t("term_click", pane=pane), FAINT) + " " + " ".join(f"{key_cap(k)} {paint(t(label, pane=pane), MUTED)}" for k, label in keys)
    return line if visible_width(line) <= cols else " ".join(key_cap(k) for k, _ in keys)


def _tool_line(tool, st, tick, now, cols):
    state = tool["state"]
    icon = {RUN: paint(SPINNER[tick % len(SPINNER)], ORANGE), OK: paint("✓", GREEN), ERR: paint("✗", RED)}.get(state, paint("–", FAINT))
    end = now if state == RUN else tool["end"]
    dur = fmt_secs(end - tool["start"]) if tool["start"] and end else ""
    name = tool_label(tool["tool"])
    color = PURPLE if tool["tool"] in EDIT_TOOLS else TEAL if (tool["tool"] or "").startswith("mcp__") else BLUE
    name_w = min(NAME_MAX, max(NAME_MIN, width(name)))
    rest = cols - 2 - 9 - name_w - 1 - width(dur) - 1
    summary = fit_left(st.rel(tool["file"]), rest) if tool["file"] else fit(tool["summary"], rest)
    return f"{icon} {paint(clock(tool['start'], True), FAINT)} {paint(fit(name, name_w), color, bold=True)} {paint(summary, TEXT)}{paint(dur, FAINT)}"


def _legend(pane):
    marks = [(paint("✓", GREEN), "term_ok"), (paint("✗", RED), "term_err"), (paint("–", FAINT), "term_lost"), (paint(SPINNER[0], ORANGE), "term_run")]
    return "  ".join(f"{mark} {paint(t(key, pane=pane), FAINT)}" for mark, key in marks)


def _side_by_side(left, right, cols, gap=GAP):
    left_w = (cols - gap) * 2 // 5
    rows = max(len(left), len(right))
    left += [""] * (rows - len(left))
    right += [""] * (rows - len(right))
    return [pad(a, left_w) + " " * gap + b for a, b in zip(left, right)]


def live_lines(st, tick, cols, rows):
    pane = st.pane
    files = sorted(st.files.items(), key=lambda kv: -kv[1]["last"])
    tools = list(st.tools.values())
    done = sum(1 for tool in tools if tool["state"] in (OK, ERR))
    failed = sum(1 for tool in tools if tool["state"] == ERR)
    lines = [f"{progress(done, len(tools), GREEN if not failed else ORANGE)} {paint(f'{done}/{len(tools)}', MUTED)}"
             + (f"  {paint(f'✗ {failed}', RED)}" if failed else ""), _legend(pane), ""]
    wide = cols >= WIDE_COLS
    files_w = (cols - GAP) * 2 // 5 if wide else cols
    tools_w = cols - files_w - GAP if wide else cols
    file_lines = [paint(t("term_none", pane=pane), FAINT)] if not files else []
    for path, changed in files[:MAX_FILES]:
        mark = badge("A", GREEN) if changed["created"] else badge("M", ORANGE)
        count = f"×{changed['count']}" if changed["count"] > 1 else ""
        file_lines.append(f"{mark} {paint(fit_left(st.rel(path), files_w - 9 - width(count)), TEXT)}{paint(count, FAINT)}")
    if len(files) > MAX_FILES:
        file_lines.append(paint(t("term_more", len(files) - MAX_FILES, pane=pane), FAINT))
    now = time.time()
    tool_lines = [_tool_line(tool, st, tick, now, tools_w - 4) for tool in reversed(tools)] or [paint(t("term_not_yet", pane=pane), FAINT)]
    files_box = box(file_lines, files_w, LINE, paint(t("term_files", len(files), pane=pane), TEXT, bold=True))
    tools_box = box(tool_lines, tools_w, LINE, paint(t("term_tools", len(tools), pane=pane), TEXT, bold=True))
    return lines + (_side_by_side(files_box, tools_box, cols) if wide else files_box + [""] + tools_box)


def _waiting_lines(pane, waiting, eta, checking, cols):
    note = t("qa_wait_checking", pane=pane) if checking else t("qa_wait_d", eta, pane=pane)
    inner = [*styled(note, cols - 4, MUTED)]
    for item in waiting:
        inner += [paint("• ", ORANGE) + line[2:] for line in styled(item["text"], cols - 4, TEXT, indent=2)[:1]]
    return box(inner, cols, ORANGE, paint(f"⏳ {t('qa_wait_t', len(waiting), pane=pane)}", ORANGE, bold=True))


def qa_lines(st, tick, cols):
    pane = st.pane
    turns = qa_store.with_overrides(pane, qa_store.records(pane, st.sid)) if st.sid else []
    waiting = WAITING.since(st.transcript, qa_store.read_cursor(pane, st.sid)) if st.sid else []
    eta = eta_seconds(turns)
    pending = Pending.active(qa_store.pending_path(pane))
    items = [i for turn in turns for i in turn.get("items") or [] if not i.get("archived")]
    answered = sum(1 for i in items if i.get("status") == qa_store.Status.ANSWERED.value)
    lines = [f"{progress(answered, len(items), GREEN)} {paint(f'{answered}/{len(items)}', MUTED)} {paint(t('st_answered', pane=pane), GREEN)}"]
    if pending:
        started = os.path.getmtime(qa_store.pending_path(pane)) if os.path.exists(qa_store.pending_path(pane)) else time.time()
        elapsed = time.time() - started
        lines.append(f"{progress(min(elapsed, eta), eta, ORANGE)} {paint(SPINNER[tick % len(SPINNER)] + ' ' + t('qa_checking', pane=pane), ORANGE)} "
                     f"{paint(f'{int(elapsed)}s / ~{eta}s', FAINT)}")
    lines.append("")
    if waiting:
        lines += _waiting_lines(pane, waiting, eta, pending, cols) + [""]
    elif not pending:
        lines += styled(t("qa_eta", eta, pane=pane), cols, FAINT) + [""]
    if not turns:
        return lines + [paint(t("qa_empty_t", pane=pane), TEXT, bold=True), *styled(t("qa_empty_d", pane=pane), cols, MUTED)]
    inner = cols - 4
    for turn in turns:
        body = []
        if turn.get("status") != "ok":
            body.append(badge(t("qa_fail", pane=pane), RED))
        shown = [i for i in turn.get("items") or [] if not i.get("archived")]
        if turn.get("status") == "ok" and not shown:
            body.append(paint(t("qa_noq", pane=pane), FAINT))
        for n, item in enumerate(shown):
            status = item.get("status")
            label = t("st_" + status, pane=pane) if status in STATUS_COLOR else status or "-"
            mid = paint(" " + t("midturn", pane=pane), FAINT) if item.get("from") == "mid-turn" else ""
            body += ([""] if n else []) + [f"{badge(label, STATUS_COLOR.get(status, FAINT))}{mid}", *styled(item.get("question"), inner, TEXT)]
            if item.get("answer"):
                body += styled(item["answer"], inner, MUTED, indent=2)
        prompt = fit((turn.get("prompt") or "").replace("\n", " "), cols - 13).rstrip()
        lines += box(body, cols, LINE, f"{paint(clock(turn.get('ts')), FAINT)} {paint(prompt, MUTED)}") + [""]
    return lines


def _pipeline(steps, step, cols, pane):
    lines = []
    for i, s in enumerate(steps):
        color = KIND_COLOR.get(s.get("kind"), MUTED)
        selected = i == step
        number = paint(f" {i + 1} ", TEXT if selected else color, tint(color, 0.6 if selected else 0.22), bold=True)
        changed = " " + badge(t("changed_short", pane=pane), YELLOW) if s.get("changed") else ""
        title_w = cols - 6 - visible_width(changed)
        title = paint(fit(s.get("title") or "", title_w), TEXT, bold=selected)
        row = f"{paint('▍', color)}{number} {title}{changed}"
        lines.append(bg(SELECTED_BG) + pad(row.replace("\033[0m", "\033[0m" + bg(SELECTED_BG)), cols) + "\033[0m" if selected else row)
    return lines


def _code(s, cols):
    code = (s.get("code") or "").split("\n")[:CODE_LINES]
    if code == [""]:
        return []
    numbers = len(str(len(code)))
    out = []
    for n, line in enumerate(code, 1):
        hit = any(h and h in line for h in s.get("highlight") or [])
        marker = paint("▌", YELLOW) if hit else " "
        text = fit(line, cols - numbers - 3)
        out.append(marker + bg(HIGHLIGHT_BG if hit else CODE_BG) + paint(str(n).rjust(numbers), FAINT, HIGHLIGHT_BG if hit else CODE_BG)
                   + bg(HIGHLIGHT_BG if hit else CODE_BG) + " " + paint(text, YELLOW if hit else TEXT, HIGHLIGHT_BG if hit else CODE_BG) + " ")
    return out


def _state(s, cols, pane):
    data = s.get("data") or []
    if not data:
        return []
    name_w = min(max(width(d.get("name") or "") for d in data), cols // 3)
    out = [paint(t("state_title", pane=pane), FAINT)]
    for d in data:
        before = d.get("before")
        moved = before not in (None, "", d.get("after"))
        value = f"{before} → {d.get('after')}" if moved else str(d.get("after"))
        dot = paint("●", ORANGE) if moved else " "
        out.append(f"{dot} {paint(fit(d.get('name') or '', name_w), BLUE)}  {paint(fit(value, cols - name_w - 4).rstrip(), TEXT)}")
    return out


def flow_lines(st, step, tick, cols):
    pane = st.pane
    lines = []
    if Pending.active(os.path.join(flow_store.flow_dir(pane), "pending")):
        lines += [paint(f"{SPINNER[tick % len(SPINNER)]} {t('flow_gen', pane=pane)}", ORANGE), ""]
    rec = next(iter(flow_store.records(pane)), None)
    if not rec:
        return lines + [paint(t("flow_empty_t", pane=pane), TEXT, bold=True), *styled(t("flow_empty_d", pane=pane), cols, MUTED)], 0
    if rec.get("status") != "ok":
        return lines + [badge(t("flow_fail", pane=pane), RED), *styled(rec.get("error"), cols, MUTED)], 0
    flow = rec.get("flow") or {}
    steps = flow.get("steps") or []
    step = max(0, min(step, len(steps) - 1))
    lines.append(f"{paint(flow.get('title') or '', TEXT, bold=True)}  {paint(clock(rec.get('ts')), FAINT)}")
    if steps:
        lines.append(f"{progress(step + 1, len(steps), BLUE)} {paint(f'{step + 1}/{len(steps)}', MUTED)}")
    if flow.get("example"):
        example = styled(flow["example"], cols, MUTED, indent=width(t("example_label", pane=pane)) + 3)
        lines += [badge(t("example_label", pane=pane), BLUE) + example[0][visible_width(badge(t("example_label", pane=pane), BLUE)):], *example[1:]]
    wide = cols >= WIDE_COLS
    pipe_w = (cols - GAP) * 2 // 5 if wide else cols
    detail_w = cols - pipe_w - GAP if wide else cols
    pipeline = box(_pipeline(steps, step, pipe_w - 4, pane), pipe_w, LINE, paint(t("pipeline", pane=pane), TEXT, bold=True))
    detail = []
    if steps:
        s = steps[step]
        color = KIND_COLOR.get(s.get("kind"), MUTED)
        inner = detail_w - 4
        body = [paint(fit(s.get("location") or "", inner).rstrip(), FAINT), *bullets(s.get("explanation"), inner)]
        code = _code(s, inner)
        state = _state(s, inner, pane)
        body += ([""] + code if code else []) + ([""] + state if state else [])
        detail = box(body, detail_w, color, paint(f"{step + 1}. {s.get('title') or ''}", color, bold=True))
    lines += [""] + (_side_by_side(pipeline, detail, cols) if wide else pipeline + [""] + detail)
    if flow.get("summary"):
        lines += ["", *styled(flow["summary"], cols, MUTED)]
    return lines, step

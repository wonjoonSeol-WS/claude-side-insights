"""The three tabs of the terminal panel, each built as a list of screen lines."""
import os
import time

from side_insights import config
from side_insights.analysis import flow_store, qa_store
from side_insights.analysis.runner import Pending
from side_insights.analysis.waiting import Waiting, eta_seconds
from side_insights.i18n import t
from side_insights.live.activity import ERR, OK, RUN, tool_label
from side_insights.live.term import (BLUE, CODE_BG, FAINT, GREEN, HIGHLIGHT_BG, LINE, MUTED, ORANGE, PURPLE, RED, RESET,
                                     SELECTED_BG, TEAL, TEXT, YELLOW, badge, bg, box, bullets, fit, fit_left, inner_width,
                                     key_cap, pad, paint, styled, tint, visible_width, width)
from side_insights.paths import EDIT_TOOLS
from side_insights.records import RecordStatus, Source, StepKind

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
CAT = "ᓚᘏᗢ"
GROUND = "⠂"
TRACK = 14
BAR = 16
CODE_LINES = 12
MAX_FILES = 30
TOOLS_IN_FLOW = 12
CHECK_MARK = {"pass": ("✓", GREEN), "fail": ("✗", RED)}
WIDE_COLS = 88
LEFT_MIN, LEFT_MAX = 30, 42
GAP = 2
NAME_MIN, NAME_MAX = 6, 14
CLOCK_COLS = 9
MIN_SUMMARY = 8
STATUS_COLOR = {qa_store.Status.ANSWERED.value: GREEN, qa_store.Status.PARTIAL.value: ORANGE,
                qa_store.Status.UNANSWERED.value: RED}
KIND_COLOR = {StepKind.INPUT.value: MUTED, StepKind.LOGIC.value: BLUE, StepKind.EXTERNAL.value: ORANGE,
              StepKind.STORAGE.value: GREEN, StepKind.OUTPUT.value: PURPLE, StepKind.CONFIG.value: MUTED,
              StepKind.TEST.value: TEAL}
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
    return paint(GROUND * spot, FAINT) + paint(CAT, ORANGE, bold=True) + paint(GROUND * (TRACK - spot), FAINT)


def _tabs(tab_keys, current, pane, labels=True):
    return " ".join(paint(f" {key} {t('mode_' + tab.value, pane=pane)} " if labels else f" {key} ", TEXT if tab == current else MUTED,
                          tint(BLUE, 0.55) if tab == current else tint(LINE, 0.6), bold=tab == current)
                    for key, tab in tab_keys.items())


def header(tab_keys, current, st, tick, cols):
    pane = st.pane
    tabs = _tabs(tab_keys, current, pane)
    top = f"{tabs}  {cat(st.busy, tick)}"
    if visible_width(top) > cols:
        top = tabs if visible_width(tabs) <= cols else _tabs(tab_keys, current, pane, labels=False)
    where = os.path.basename((st.cwd or "").rstrip("/")) or "-"
    status = paint(f"{SPINNER[tick % len(SPINNER)]} {t('busy', pane=pane)}", ORANGE) if st.busy \
        else paint(f"○ {t('idle', pane=pane)}", FAINT)
    room = cols - visible_width(status) - 2
    return [top, f"{status}  {paint(fit(where + '  /  ' + (st.sid or '-')[:8], room).rstrip(), FAINT)}", ""]


def footer(pane, cols):
    keys = [("1 2 3", "term_k_tabs"), ("←→", "term_k_steps"), ("↑↓", "term_k_scroll"), ("o", "term_k_open"), ("q", "term_k_quit")]
    labelled = " ".join(f"{key_cap(k)} {paint(t(label, pane=pane), MUTED)}" for k, label in keys)
    for line in (paint(t("term_click", pane=pane), FAINT) + " " + labelled, labelled, " ".join(key_cap(k) for k, _ in keys)):
        if visible_width(line) <= cols:
            return line
    return ""


def _tool_line(tool, st, tick, now, cols):
    state = tool["state"]
    icon = {RUN: paint(SPINNER[tick % len(SPINNER)], ORANGE), OK: paint("✓", GREEN), ERR: paint("✗", RED)}.get(state, paint("–", FAINT))
    end = now if state == RUN else tool["end"]
    dur = fmt_secs(end - tool["start"]) if tool["start"] and end else ""
    name = tool_label(tool["tool"])
    color = PURPLE if tool["tool"] in EDIT_TOOLS else TEAL if (tool["tool"] or "").startswith("mcp__") else BLUE
    name_w = min(NAME_MAX, max(NAME_MIN, width(name)))
    stamp = paint(clock(tool["start"], True), FAINT) + " "
    rest = cols - 2 - CLOCK_COLS - name_w - 1 - width(dur) - 1
    if rest < MIN_SUMMARY:
        stamp, rest = "", rest + CLOCK_COLS
    if rest < MIN_SUMMARY:
        name_w, rest = NAME_MIN, rest + name_w - NAME_MIN
    summary = fit_left(st.rel(tool["file"]), rest) if tool["file"] else fit(tool["summary"], rest)
    return f"{icon} {stamp}{paint(fit(name, name_w), color, bold=True)} {paint(summary, TEXT)} {paint(dur, FAINT)}"


def _legend(pane, cols):
    marks = [(paint("✓", GREEN), "term_ok"), (paint("✗", RED), "term_err"), (paint("–", FAINT), "term_lost"), (paint(SPINNER[0], ORANGE), "term_run")]
    line = "  ".join(f"{mark} {paint(t(key, pane=pane), FAINT)}" for mark, key in marks)
    return line if visible_width(line) <= cols else " ".join(mark for mark, _ in marks)


def _split(cols):
    left = max(LEFT_MIN, min(LEFT_MAX, (cols - GAP) * 2 // 5))
    return left, cols - left - GAP


def _side_by_side(left, right, left_w):
    rows = max(len(left), len(right))
    left += [""] * (rows - len(left))
    right += [""] * (rows - len(right))
    return [pad(a, left_w) + " " * GAP + b for a, b in zip(left, right)]


def live_lines(st, tick, cols, rows):
    pane = st.pane
    files = sorted(st.files.items(), key=lambda kv: -kv[1]["last"])
    tools = list(st.tools.values())
    done = sum(1 for tool in tools if tool["state"] in (OK, ERR))
    failed = sum(1 for tool in tools if tool["state"] == ERR)
    lines = [f"{progress(done, len(tools), GREEN if not failed else ORANGE)} {paint(f'{done}/{len(tools)}', MUTED)}"
             + (f"  {paint(f'✗ {failed}', RED)}" if failed else ""), _legend(pane, cols), ""]
    wide = cols >= WIDE_COLS
    files_w, tools_w = _split(cols) if wide else (cols, cols)
    file_lines = [paint(t("term_none", pane=pane), FAINT)] if not files else []
    for path, changed in files[:MAX_FILES]:
        mark = badge("A", GREEN) if changed["created"] else badge("M", ORANGE)
        count = f"×{changed['count']}" if changed["count"] > 1 else ""
        file_lines.append(f"{mark} {paint(fit_left(st.rel(path), inner_width(files_w) - 4 - width(count)), TEXT)}{paint(count, FAINT)}")
    if len(files) > MAX_FILES:
        file_lines.append(paint(t("term_more", len(files) - MAX_FILES, pane=pane), FAINT))
    now = time.time()
    tool_lines = [_tool_line(tool, st, tick, now, inner_width(tools_w)) for tool in reversed(tools)] or [paint(t("term_not_yet", pane=pane), FAINT)]
    files_box = box(file_lines, files_w, LINE, paint(t("term_files", len(files), pane=pane), TEXT, bold=True))
    tools_box = box(tool_lines, tools_w, LINE, paint(t("term_tools", len(tools), pane=pane), TEXT, bold=True))
    return lines + (_side_by_side(files_box, tools_box, files_w) if wide else files_box + [""] + tools_box)


def _waiting_lines(pane, waiting, eta, checking, cols):
    note = t("qa_wait_checking", pane=pane) if checking else t("qa_wait_d", eta, pane=pane) if config.load(pane)["qa_auto"] \
        else t("qa_wait_off", pane=pane)
    inner = [*styled(note, inner_width(cols), MUTED), ""]
    for item in waiting:
        mid = "  " + t("midturn", pane=pane) if item["mid_turn"] else ""
        text = fit(item["text"].replace("\n", " "), inner_width(cols) - 2 - width(mid)).rstrip()
        inner.append(paint("• ", ORANGE) + paint(text, TEXT) + paint(mid, FAINT))
    return box(inner, cols, ORANGE, paint(f"⏳ {t('qa_wait_t', len(waiting), pane=pane)}", ORANGE, bold=True))


def qa_lines(st, tick, cols):
    pane = st.pane
    turns = qa_store.with_overrides(pane, qa_store.records(pane, st.sid)) if st.sid else []
    waiting = WAITING.since(st.transcript, qa_store.read_cursor(pane, st.sid)) if st.sid else []
    eta = eta_seconds(turns)
    pending = Pending.active(qa_store.pending_path(pane))
    items = [i for turn in turns for i in turn.get("items") or [] if not i.get("archived")]
    answered = sum(1 for i in items if i.get("status") == qa_store.Status.ANSWERED.value)
    bar = f"{progress(answered, len(items), GREEN)} {paint(f'{answered}/{len(items)}', MUTED)}"
    labelled = f"{bar} {paint(t('st_answered', pane=pane), GREEN)}"
    lines = [labelled if visible_width(labelled) <= cols else bar]
    if pending:
        elapsed = time.time() - float(pending.get("since") or time.time())
        lines.append(f"{progress(min(elapsed, eta), eta, ORANGE)} {paint(SPINNER[tick % len(SPINNER)] + ' ' + t('qa_checking', pane=pane), ORANGE)} "
                     f"{paint(f'{int(elapsed)}s / ~{eta}s', FAINT)}")
    lines.append("")
    if waiting:
        lines += _waiting_lines(pane, waiting, eta, pending, cols) + [""]
    elif not pending:
        lines += styled(t("qa_eta", eta, pane=pane), cols, FAINT) + [""]
    if not turns:
        return lines + [paint(t("qa_empty_t", pane=pane), TEXT, bold=True), *styled(t("qa_empty_d", pane=pane), cols, MUTED)]
    inner = inner_width(cols)
    for turn in turns:
        body = []
        if turn.get("status") != RecordStatus.OK.value:
            body.append(badge(t("qa_fail", pane=pane), RED))
        shown = [i for i in turn.get("items") or [] if not i.get("archived")]
        if turn.get("status") == RecordStatus.OK.value and not shown:
            body.append(paint(t("qa_noq", pane=pane), FAINT))
        for n, item in enumerate(shown):
            status = item.get("status")
            label = t("st_" + status, pane=pane) if status in STATUS_COLOR else status or "-"
            chip = badge(label, STATUS_COLOR.get(status, FAINT))
            mid = t("midturn", pane=pane) if item.get("from") == Source.MID_TURN.value else ""
            mid = paint(" " + fit(mid, inner - visible_width(chip) - 1).rstrip(), FAINT) if mid else ""
            body += ([""] if n else []) + [f"{chip}{mid}",
                                            *styled(item.get("question"), inner, TEXT, indent=2, bold=True)]
            if item.get("answer"):
                body += styled(item["answer"], inner, MUTED, indent=4)
        stamp = clock(turn.get("ts"))
        prompt = fit((turn.get("prompt") or "").replace("\n", " "), cols - width(stamp) - 8).rstrip()
        lines += box(body, cols, LINE, f"{paint(stamp, FAINT)} {paint(prompt, MUTED)}") + [""]
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
        lines.append(bg(SELECTED_BG) + pad(row.replace(RESET, RESET + bg(SELECTED_BG)), cols) + RESET if selected else row)
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


def _state_box(steps, step, cols, pane):
    """Every traced value up to this step, newest value per name; the ones this step changed are marked."""
    values = {}
    for i, s in enumerate(steps[:step + 1]):
        for d in s.get("data") or []:
            values[d.get("name") or ""] = (d, i == step)
    inner = inner_width(cols)
    if not values:
        body = [paint(fit(t("state_empty", pane=pane), inner).rstrip(), FAINT)]
    else:
        name_w = min(max(width(name) for name in values), inner // 3)
        body = []
        for name, (d, now) in values.items():
            before = d.get("before")
            moved = now and before not in (None, "", d.get("after"))
            value = f"{before} → {d.get('after')}" if moved else str(d.get("after"))
            dot = paint("●", ORANGE) if now else " "
            body.append(f"{dot} {paint(fit(name, name_w), BLUE if now else MUTED)}  {paint(fit(value, inner - name_w - 4).rstrip(), TEXT if now else MUTED)}")
    return box(body, cols, YELLOW if any(now for _, now in values.values()) else LINE, paint(t("state_title", pane=pane), TEXT, bold=True))


def _flow_cards(st, rec, flow, tick, cols):
    """Changes, checks, the request and recent tools, as boxes under the step detail."""
    pane, inner = st.pane, inner_width(cols)
    cards = []
    changes = flow.get("changes") or []
    if changes:
        body = []
        for change in changes:
            body += ([""] if body else []) + [f"{badge('M', ORANGE)} {paint(fit_left(change.get('file') or '', inner - 4).rstrip(), TEXT)}",
                                              *styled(change.get("what"), inner, MUTED, indent=4)]
        cards += [""] + box(body, cols, LINE, paint(t("changes", len(changes), pane=pane), TEXT, bold=True))
    checks = flow.get("checks") or []
    if checks:
        body = []
        for check in checks:
            mark, color = CHECK_MARK.get(check.get("status"), ("?", FAINT))
            body.append(f"{paint(mark, color)} {paint(fit(check.get('label') or '', inner - 2).rstrip(), TEXT)}")
        cards += [""] + box(body, cols, LINE, paint(t("checks", pane=pane), TEXT, bold=True))
    if rec.get("prompt"):
        meta = " / ".join(x for x in (rec.get("model"), f"${rec['cost']:.3f}" if rec.get("cost") else "") if x)
        cards += [""] + box([*styled(rec["prompt"], inner, MUTED), *([paint(meta, FAINT)] if meta else [])], cols, LINE,
                            paint(t("request", pane=pane), TEXT, bold=True))
    tools = [tool for tool in st.tools.values() if not rec.get("ts") or (tool["start"] or 0) <= rec["ts"]][-TOOLS_IN_FLOW:]
    if tools:
        now = time.time()
        cards += [""] + box([_tool_line(tool, st, tick, now, inner) for tool in reversed(tools)], cols, LINE,
                            paint(t("term_tools", len(tools), pane=pane), TEXT, bold=True))
    return cards


def flow_lines(st, step, tick, cols):
    pane = st.pane
    lines = []
    if Pending.active(flow_store.pending_path(pane)):
        lines += [paint(f"{SPINNER[tick % len(SPINNER)]} {t('flow_gen', pane=pane)}", ORANGE), ""]
    rec = flow_store.latest(pane)
    if not rec:
        return lines + [paint(t("flow_empty_t", pane=pane), TEXT, bold=True), *styled(t("flow_empty_d", pane=pane), cols, MUTED)], 0
    if rec.get("status") != RecordStatus.OK.value:
        return lines + [badge(t("flow_fail", pane=pane), RED), *styled(rec.get("error"), cols, MUTED)], 0
    flow = rec.get("flow") or {}
    steps = flow.get("steps") or []
    step = max(0, min(step, len(steps) - 1))
    lines.append(f"{paint(flow.get('title') or '', TEXT, bold=True)}  {paint(clock(rec.get('ts')), FAINT)}")
    if steps:
        lines.append(f"{progress(step + 1, len(steps), BLUE)} {paint(f'{step + 1}/{len(steps)}', MUTED)}")
    if flow.get("example"):
        label = badge(t("example_label", pane=pane), BLUE)
        example = styled(flow["example"], cols, MUTED, indent=visible_width(label) + 1)
        lines += [label + " " + example[0].lstrip(" "), *example[1:]]
    if flow.get("summary"):
        lines += ["", *styled(flow["summary"], cols, TEXT)]
    wide = cols >= WIDE_COLS
    pipe_w, detail_w = _split(cols) if wide else (cols, cols)
    pipeline = box(_pipeline(steps, step, inner_width(pipe_w), pane), pipe_w, LINE, paint(t("pipeline", pane=pane), TEXT, bold=True))
    detail = []
    if steps:
        s = steps[step]
        color = KIND_COLOR.get(s.get("kind"), MUTED)
        inner = inner_width(detail_w)
        body = [paint(fit(s.get("location") or "", inner).rstrip(), FAINT), *bullets(s.get("explanation"), inner)]
        code = _code(s, inner)
        body += [""] + code if code else []
        detail = box(body, detail_w, color, paint(f"{step + 1}. {s.get('title') or ''}", color, bold=True))
        detail += [""] + _state_box(steps, step, detail_w, pane)
    detail += _flow_cards(st, rec, flow, tick, detail_w)
    lines += [""] + (_side_by_side(pipeline, detail, pipe_w) if wide else pipeline + [""] + detail)
    return lines, step

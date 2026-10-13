def cut(n): if type == "string" and length > n then .[0:n] + "…" else . end;
(.tool_input // {}) as $in
| {
    ts: ($ts | tonumber),
    ev: .hook_event_name,
    sid: .session_id,
    cwd: .cwd,
    id: .tool_use_id,
    tool: .tool_name,
    file: ($in.file_path // $in.notebook_path // null),
    summary: (($in.description // $in.command // $in.pattern // $in.url // $in.query
               // $in.prompt // $in.skill // $in.file_path // $in.path // "")
              | tostring | gsub("\\s+"; " ") | cut(300)),
    kind: ((.tool_response | objects | .type) // null),
    error: (if .hook_event_name == "PostToolUseFailure" then true
            elif .hook_event_name == "PostToolUse"
            then ([.tool_response | objects | (.is_error // .error // false)] | any(. != false and . != null))
            else null end)
  }

def cut(n): if type == "string" and length > n then .[0:n] + "…" else . end;
(.tool_input // {}) as $in
| {
    ts: now,
    ev: .hook_event_name,
    sid: .session_id,
    cwd: .cwd,
    transcript: .transcript_path,
    id: .tool_use_id,
    tool: .tool_name,
    file: ($in.file_path // $in.notebook_path // null),
    summary: (($in.description // $in.command // $in.pattern // $in.url // $in.query
               // $in.prompt // $in.skill // $in.file_path // $in.path // "")
              | tostring | gsub("[[:cntrl:]]"; " ") | gsub("\\s+"; " ") | cut(300)),
    kind: ((.tool_response | objects | .type) // null),
    error: (if .hook_event_name == "PostToolUseFailure" then true
            elif .hook_event_name == "PostToolUse"
            then ([.tool_response | objects | (.is_error, .error)] | any(. == true or (type == "string" and length > 0)))
            else null end),
    reason: (if .hook_event_name == "PostToolUseFailure" then (.error // "")
             elif .hook_event_name == "PostToolUse"
             then ((.tool_response | objects | (.error // .stderr // "")) // "")
             else "" end
             | tostring | gsub("[[:cntrl:]]"; " ") | gsub("\\s+"; " ") | cut(600))
  } as $event
| ($event | tojson),
  (if .hook_event_name == "Stop" and (.transcript_path // "") != ""
   then {transcript: .transcript_path, cwd: (.cwd // "")} | (tojson, .transcript, .cwd)
   else empty end)

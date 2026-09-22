# AIR client profile

This document is the wire contract between the JetBrains AIR client and the two ACP adapters that JetBrains
maintains: `codex-acp` and `claude-agent-acp`. It is the same text in both repositories.

## Negotiation

- AIR sends `initialize.clientCapabilities._meta.jetbrains.air = {version, capabilities: [...]}`.
- A client is AIR when this object is present. AIR is not released yet, so there is no older AIR shape to keep.
- For AIR, an adapter builds every tool call report through one class (`AirToolCallProfile`). The class sends
  exactly the fields listed here. Every other client keeps the standard ACP shape.

## Rule: one fact, one field

| Fact | The only field that carries it |
|---|---|
| Tool parameters | `rawInput`, once they are complete, and again only when they change |
| File text of an edit | the diff in `content` (a patch when `diffPatch` is negotiated). Never also in `rawInput` |
| Result to show (read text, search hits, report, fetch answer) | `content` |
| Structured MCP result | `rawOutput.{result, error}` |
| Any other result without `content` (confirmation text, rejection reason) | `rawOutput` |
| Command output | `_meta.terminal_output_delta` appends |
| MCP progress | `_meta.mcp_output_delta` appends, with the text unchanged |
| Status, title, kind, locations | the field itself, only when it changes |
| Client flags | `_meta.jetbrains.air.*`, only when they change |

- An update carries only the fields that changed since the last report of that tool call.
- Input is never copied into `content`, `title`, or `_meta`. Output is never copied into `rawOutput` when it is in `content`.

## Tool call fields for AIR

`tool_call` and `tool_call_update` for AIR carry only these fields.

| Field | Contents |
|---|---|
| `toolCallId`, `status`, `kind` | standard |
| `title` | a short label. Not the input and not the output |
| `locations` | the file paths of read, search, and edit tools |
| `content` | result blocks: `text`, `diff`, `terminal` (a command marker), `image`, `resource_link` |
| `rawInput` | the tool parameters. AIR reads `command`, `path`, `url`, `arguments`, `plan`, `planFilePath` and the Codex collaboration fields, and shows the whole object as the tool input. For an edit, the file text keys (`content`, `old_string`, `new_string`, `new_source`) are left out, because the diff holds them |
| `rawOutput` | see the rule table |
| `_meta.terminal_output_delta.data` | appended command output |
| `_meta.mcp_output_delta.data` | appended MCP progress, unchanged text |
| `_meta.is_mcp_tool_call` | `true` for an MCP tool call |
| `_meta.claudeCode.toolName` | Claude only. AIR reads `Agent`, `Task`, `ToolSearch` |
| `_meta.claudeCode.parentToolUseId` | Claude only. The parent tool call of a subagent child |
| `_meta.claudeCode.toolResponse.{isAsync, status}` | Claude only. Marks an async subagent launch |
| `_meta.jetbrains.air.subagent` | `true` for a subagent tool call |
| `_meta.jetbrains.air.commandTitle` | the concise description of a shell command |
| `_meta.jetbrains.air.skill` | `{name, path}` of a loaded skill |
| `_meta.jetbrains.air.contextCompaction` | `{version: 1, trigger, preTokens, postTokens, durationMs, error}` |
| `_meta.jetbrains.air.asyncTasks.backgrounded` | `true` for a command that became an async task |
| `_meta.jetbrains.air.terminalInput.data` | text that was written to the stdin of a command |
| diff `_meta.jetbrains.air.diffPatch` | unchanged, see `diff-patch-extension.md` |

AIR does not read these, so the profile does not send them: `terminal_info`, `terminal_exit`, `terminal_output`
snapshots, `rawOutput.formatted_output`, `rawOutput.exit_code`, `_meta.codex.*` on tool calls,
`_meta.claudeCode.title`, `claudeCode.subagent`, `claudeCode.skill`, `claudeCode.skillPath`, and any other
`claudeCode` key that the table does not list.

## Permission requests for AIR

- The request `toolCall` carries `toolCallId`, `title`, and `rawInput`. AIR builds the approval from them.
- It does not repeat `content`, `locations`, `kind`, or `status` that the client already has.
- The presentation moves to `_meta.jetbrains.air.permission = {version, title, description}` on the request,
  and `_meta.jetbrains.air.permission = {version, description}` on an option.
- A Codex plan review carries `_meta.jetbrains.air.planReview = {planItemId}`. The plan text is not repeated.

## Other moved keys

| Old key | New key |
|---|---|
| `agent_message_chunk._meta.codex.phase` | `_meta.jetbrains.air.phase` (same values) |
| `initialize._meta.goal`, `session_info_update._meta.goal` | `_meta.jetbrains.air.goal` (same shape) |
| mode `_meta.kind`, config option value `_meta.kind` | `_meta.jetbrains.air.kind` |
| available command `_meta.commandAction` | `_meta.jetbrains.air.commandAction` |
| elicitation property `_meta._askUserQuestionCustomAnswer` | `_meta.jetbrains.air.customAnswer` (same value) |
| tool call `_meta.contextCompaction` | `_meta.jetbrains.air.contextCompaction` |

Keys that other teams or upstream own stay where they are: `terminal_output_delta`, `mcp_output_delta`,
`is_mcp_tool_call`, `is_mcp_tool_approval`, `steering`, `quota`, `authStatus`, `claudeCode.toolName`,
`claudeCode.parentToolUseId`, `claudeCode.toolResponse`.

## Streams

- A plan that the agent streams goes out as `plan_update` with `_meta.jetbrains.air.contentDelta`, a text that
  AIR appends to the plan content. The first report of a plan carries the whole content once.
- Streamed subagent text is not sent again in full when the complete message arrives.
- A compaction summary that went out as chunks is not sent again in full at the end.

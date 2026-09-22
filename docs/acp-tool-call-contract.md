# ACP tool call contract

This document is the wire contract of the two ACP adapters that JetBrains maintains: `codex-acp` and
`claude-agent-acp`. It is the same text in both repositories. It applies to every client. Zed and AIR are the
two clients that the adapters test against.

## Rule: one fact, one field

Every client gets the standard ACP shape. Each fact goes in exactly one field.

| Fact | The only field that carries it |
|---|---|
| Tool parameters | `rawInput`, once they are complete, and again only when they change |
| File text of an edit | the diff in `content` (a patch when `diffPatch` is negotiated). Never also in `rawInput` |
| Result to show (read text, search hits, report, fetch answer, MCP text result) | `content` |
| A result that has no display form (structured MCP result, rejection reason) | `rawOutput` |
| Command output | the terminal channel that the client negotiated (see below) |
| MCP progress | `_meta.mcp_output_delta` appends, with the text unchanged |
| Status, title, kind, locations | the field itself, only when it changes |

- An update carries only the fields that changed since the last report of that tool call.
- Input is never copied into `title` or `_meta`, with two exceptions. The `title` of a command, a read, a search,
  or an MCP call names the command, the path, or the query, because Zed shows the title as that label.
  `_meta.jetbrains.air.commandTitle` carries the concise description of a shell command for AIR.
- Some input is what the user reads: the plan to approve, the prompt of a subagent, a question, the description
  of a command. AIR renders `rawInput` itself and declares `rawInputRendering` in
  `initialize.clientCapabilities._meta.jetbrains.air.capabilities`. AIR gets no copy of the input in `content`.
  Every other client gets one display copy of that input in `content`, so Zed keeps its rendering.
- Output is never copied into `rawOutput` when it is in `content`, and never into `content` when it is in the terminal channel.
- `title` is a short label. It is not the output.

## Terminal channel

- A command tool call has `content: [{type: "terminal", terminalId}]` and `_meta.terminal_info` (Zed convention).
- A client that declares `terminal_output_delta` gets appends in `_meta.terminal_output_delta.data`.
- Every other client gets `_meta.terminal_output.data` chunks (Zed convention).
- The end of a command sends `_meta.terminal_exit` (Zed convention). `rawOutput.formatted_output` and
  `rawOutput.exit_code` are not sent.
- Text written to the stdin of a command goes to `_meta.terminal_input.data`, not into the output.
- Output of a tool that is not a command (read, search, list) is a result: it goes to `content`.

## Tool metadata

These keys are optional extensions. A client that does not know them loses nothing that it could render.

| Key | Meaning |
|---|---|
| `_meta.is_mcp_tool_call` | `true` for an MCP tool call |
| `_meta.jetbrains.air.subagent` | `true` for a subagent tool call |
| `_meta.jetbrains.air.commandTitle` | the concise description of a shell command |
| `_meta.jetbrains.air.skill` | `{name, path}` of a loaded skill |
| `_meta.jetbrains.air.contextCompaction` | `{version: 1, trigger, preTokens, postTokens, durationMs, error}` |
| `_meta.jetbrains.air.asyncTasks.backgrounded` | `true` for a command that became an async task |
| `_meta.claudeCode.toolName`, `.parentToolUseId`, `.toolResponse.{isAsync, status}` | Claude only, upstream keys |
| diff `_meta.jetbrains.air.diffPatch` | see `diff-patch-extension.md` |

`_meta.codex.subagent`, `_meta.codex.collaboration`, `_meta.claudeCode.title`, `claudeCode.subagent`,
`claudeCode.skill`, and `claudeCode.skillPath` are not sent.

## Permission requests

- The request `toolCall` carries `toolCallId`, `title`, and `rawInput`. A client builds the approval from them.
- It repeats nothing else that the client already has, unless the request shows something new (for example a
  preview diff of the change to approve).
- `_meta.jetbrains.air.permission = {version, title, description}` on the request, and
  `{version, description}` on an option.
- A Codex plan review carries `_meta.jetbrains.air.planReview = {planItemId}`. It does not repeat the plan text.

## Moved keys

| Old key | New key |
|---|---|
| `agent_message_chunk._meta.codex.phase` | `_meta.jetbrains.air.phase` (same values) |
| `initialize._meta.goal`, `session_info_update._meta.goal` | `_meta.jetbrains.air.goal` (same shape) |
| mode `_meta.kind`, config option value `_meta.kind` | `_meta.jetbrains.air.kind` |
| available command `_meta.commandAction` | `_meta.jetbrains.air.commandAction` |
| elicitation property `_meta._askUserQuestionCustomAnswer` | `_meta.jetbrains.air.customAnswer` (same value) |
| tool call `_meta.contextCompaction` | `_meta.jetbrains.air.contextCompaction` |

Keys that other teams or upstream own stay where they are: `terminal_info`, `terminal_output`, `terminal_exit`,
`terminal_output_delta`, `mcp_output_delta`, `is_mcp_tool_call`, `is_mcp_tool_approval`, `steering`, `quota`,
`authStatus`, and the upstream `claudeCode.*` keys.

## Streams

- A plan that the agent streams goes out as `plan_update` with `_meta.jetbrains.air.contentDelta`, a text that
  AIR appends to the plan content. AIR declares `planContentDelta` for it. Other clients get
  `plan_update` snapshots.
- Streamed message text is not sent again in full when the complete message arrives, also for subagents.
- A compaction summary that went out as chunks is not sent again in full at the end.

## Adapter structure

- A `ToolReporter` per tool kind reads the upstream event once and produces tool facts.
- One `AcpToolCallRenderer` turns the facts into the ACP fields above. The AIR choices live in one
  `ClientCapabilities` object that the renderer reads. The `jetbrains.air` capabilities are AIR capabilities:
  the adapters do not treat them as a generic client feature.
- A changed-field filter drops the fields that an earlier report of the same tool call already sent.

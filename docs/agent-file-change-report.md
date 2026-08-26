# Agent file-change report

Standard ACP can describe a change from one tool call. It has no complete file list for one prompt turn.

This adapter supports the version-1 `agentFileChangeReport` extension. The client and adapter must both advertise it in `_meta.jetbrains.air.capabilities` during `initialize`.

The client adds this object to `session/prompt`:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "agentFileChangeReportRequest": {
          "version": 1,
          "requestId": "a-unique-request-id"
        }
      }
    }
  }
}
```

The request identifier has 1 to 128 characters. It can contain ASCII letters, digits, `.`, `_`, `:`, and `-`.

The adapter starts a hidden Stop-hook continuation after the main turn. The continuation can call only the internal report tool. Its output does not enter the visible transcript.

The adapter sends one `session_info_update` before the `PromptResponse`:

```json
{
  "sessionUpdate": "session_info_update",
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "agentFileChangeReport": {
          "version": 1,
          "requestId": "a-unique-request-id",
          "status": "reported",
          "paths": ["/workspace/src/App.ts"],
          "declaredComplete": true,
          "truncated": false,
          "uncertainty": "Optional short explanation"
        }
      }
    }
  }
}
```

Each path is an absolute normalized path in the working directory or an additional workspace directory. The report contains no file content, diff, line count, or path order guarantee.

The adapter sends at most 1,024 paths. Each path has at most 4,096 characters. The serialized report has at most 256 KiB. The optional uncertainty has at most 2,000 characters.

The adapter marks the result unavailable after its audit timeout. It can use `cancelled`, `timeout`, `invalidOutput`, `notReported`, or `providerError` as the reason. The main prompt still completes.

The client must match the request identifier. It must ignore a duplicate, stale, malformed, or unavailable report.

Rollback is outside this extension. A client can show it only when `available_commands_update` contains an `undo` or `rollback` command.

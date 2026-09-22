# AIR diff patch extension

Status: Experimental

This extension lets an ACP agent send one compact Git patch instead of file text snapshots.
It applies to an ACP `diff` content block.

## Capability negotiation

The client advertises `diffPatch` in the initialize request:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["diffPatch"]
        }
      }
    }
  }
}
```

The adapter advertises the same capability in the initialize response:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "capabilities": ["diffPatch"]
      }
    }
  }
}
```

The adapter uses patch mode only when both peers advertise `diffPatch` with an AIR envelope version of at least 1.
If either declaration is absent or malformed, the adapter sends the standard `oldText` and `newText` values.

## Diff content

Patch mode puts the payload at `_meta.jetbrains.air.diffPatch`:

```json
{
  "type": "diff",
  "path": "/workspace/src/App.ts",
  "oldText": null,
  "newText": "",
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "diffPatch": {
          "version": 1,
          "format": "git_patch",
          "text": "diff --git a/workspace/src/App.ts b/workspace/src/App.ts\n--- a/workspace/src/App.ts\n+++ b/workspace/src/App.ts\n@@ -1 +1 @@\n-old\n+new\n"
        }
      }
    }
  }
}
```

| Field     | Type    | Meaning                                     |
| --------- | ------- | ------------------------------------------- |
| `version` | integer | Must equal `1`.                             |
| `format`  | string  | Must equal `git_patch`.                     |
| `text`    | string  | One unified Git patch for the block's file. |

The patch contains file headers and at least one `@@` hunk.
The headers follow `git diff`.
The path loses its leading slash, gets the `a/` and `b/` prefixes, and is quoted when git would quote it.
An added file has a `new file mode 100644` line and uses `/dev/null` as the old file header.
A deleted file would have a `deleted file mode 100644` line and use `/dev/null` as the new file header.
The Claude adapter never sends a deleted file, because no Claude file tool deletes a file.
The patch keeps CR bytes and the `\ No newline at end of file` marker.

In patch mode, `oldText: null` and `newText: ""` are placeholders that satisfy the ACP schema.
They are not file snapshots or changed fragments.
The receiver must use `diffPatch.text` as the change payload after it accepts the negotiated extension.

The receiver derives line counts and changed fragments from the patch.

## Compatibility and fallback

The adapter sends the patch form only to a client that advertised `diffPatch`.
When the adapter cannot build an exact patch, it sends the standard ACP diff instead.
That standard diff contains meaningful `oldText` and `newText` values and omits `diffPatch`.

A block that carries `diffPatch` has no usable text fields.
A receiver that rejects the patch must show the change as unavailable.
It must not render the placeholders as an empty file.
Unknown fields do not invalidate a valid payload.

## Claude behavior

Before an `Edit` or `Write` approval, the adapter reads the target file and applies the tool input in memory.
It sends the resulting patch only when it can predict the written bytes exactly.
This keeps a 12,000-line file out of the approval payload when the change is small.
The adapter sends no preview patch in these cases, and the tool call keeps its standard diff:

- The file is larger than 1 MiB, is binary, is not valid UTF-8, or contains a CR.
- The `Edit` file is missing for a non-empty `old_string`, or the `old_string` does not match exactly once.
- The change leaves the file unchanged.

An `Edit` input holds a snippet, not the file.
The tool call therefore shows the standard diff of the snippet until a preview or the final patch replaces it.
A `Write` tool call shows a creation patch of its content.

After the tool runs, the adapter diffs the SDK `originalFile` against the file on disk.
It does not use the SDK `structuredPatch` hunks for a patch.
Claude converts leading tabs and CRLF line endings in those hunks, so they do not match the file.
If the written file is too large, binary, or contains a CR or a byte order mark, the adapter sends the standard diff.
A created file gets a creation patch.

import type {
  FileEditInput,
  FileWriteInput,
  NotebookEditInput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import {
  patchUpdateFromDiffToolResponse,
  toolUpdateFromDiffToolResponse,
  writeToolUseChange,
} from "../../diff.js";
import { markdownEscape, resultText, textContent, toDisplayPath } from "../content.js";
import type {
  ToolReporter,
  ToolResultContext,
  ToolResultFacts,
  ToolUseContext,
  ToolUseFacts,
} from "../facts.js";

/**
 * Write: the diff holds the file text. The PostToolUse hook sends the final
 * diff, so the result text is only a confirmation.
 */
export class WriteReporter implements ToolReporter {
  toolUse(input: unknown, { cwd, capabilities }: ToolUseContext): ToolUseFacts {
    const write = input as FileWriteInput | undefined;
    const displayPath = write?.file_path ? toDisplayPath(write.file_path, cwd) : undefined;
    const facts: ToolUseFacts = {
      title: displayPath ? `Write ${displayPath}` : "Preparing file…",
      kind: "edit",
      locations: write?.file_path ? [{ path: write.file_path }] : [],
    };
    if (write?.file_path) {
      // A negotiated client gets the creation patch that the PostToolUse hook
      // would send for a new file, so that update can be skipped. An existing
      // file never gets a creation patch.
      const negotiated =
        capabilities.diffPatch && typeof write.content === "string"
          ? writeToolUseChange(write.file_path, write.content, cwd)
          : undefined;
      facts.change = negotiated?.change ?? [
        {
          type: "diff",
          path: write.file_path,
          oldText: null,
          newText: write.content,
        },
      ];
      // A notice holds no file text, so rawInput keeps the content.
      if (negotiated?.holdsFileText !== false) facts.fileTextKeys = ["content"];
    } else if (write?.content) {
      facts.display = [textContent(write.content)];
    }
    return facts;
  }

  toolResult(): ToolResultFacts {
    return {};
  }

  hookResult(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts> {
    return finalChange(toolResponse, context);
  }
}

/** Edit: the diff holds the old and the new text. */
export class EditReporter implements ToolReporter {
  toolUse(input: unknown, { cwd }: ToolUseContext): ToolUseFacts {
    const edit = input as FileEditInput | undefined;
    const displayPath = edit?.file_path ? toDisplayPath(edit.file_path, cwd) : undefined;
    const facts: ToolUseFacts = {
      title: displayPath ? `Edit ${displayPath}` : "Edit",
      kind: "edit",
      locations: edit?.file_path ? [{ path: edit.file_path }] : [],
    };
    if (edit?.file_path && (edit.old_string || edit.new_string)) {
      // The standard diff, also for a client that negotiated patches: the
      // input holds a snippet, not the file, so a patch would need line
      // numbers that the adapter does not know here.
      facts.change = [
        {
          type: "diff",
          path: edit.file_path,
          oldText: edit.old_string || null,
          newText: edit.new_string ?? "",
        },
      ];
      facts.fileTextKeys = ["old_string", "new_string"];
    }
    return facts;
  }

  toolResult(): ToolResultFacts {
    return {};
  }

  hookResult(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts> {
    return finalChange(toolResponse, context);
  }
}

/**
 * The final change of an Edit or a Write, from the structuredPatch of the
 * PostToolUse `tool_response`. For Write it replaces the optimistic creation
 * diff with the real diff of an updated file. A negotiated client gets an
 * exact git patch built from the written file, or the standard diff when none
 * can be built.
 */
async function finalChange(
  toolResponse: unknown,
  { capabilities }: ToolUseContext,
): Promise<ToolResultFacts> {
  return (
    (capabilities.diffPatch ? await patchUpdateFromDiffToolResponse(toolResponse) : undefined) ??
    toolUpdateFromDiffToolResponse(toolResponse)
  );
}

/**
 * NotebookEdit: the new cell source is input. ACP has no notebook diff, and a
 * `diff` block would name the `.ipynb` file with cell text instead of file
 * text, so the source stays in `rawInput` and gets a display copy.
 *
 * Only AIR gets this rendering. Every other client gets the generic rendering
 * of the upstream adapter.
 */
export class NotebookEditReporter implements ToolReporter {
  toolUse(input: unknown, { cwd, capabilities }: ToolUseContext): ToolUseFacts {
    if (!capabilities.air.client) return { title: "NotebookEdit", kind: "other" };
    const notebook = input as Partial<NotebookEditInput> | undefined;
    const displayPath = notebook?.notebook_path
      ? toDisplayPath(notebook.notebook_path, cwd)
      : undefined;
    const cell = notebook?.cell_id ? ` ${notebook.cell_id}` : "";
    const verb =
      notebook?.edit_mode === "insert"
        ? "Insert"
        : notebook?.edit_mode === "delete"
          ? "Delete"
          : "Edit";
    const source = notebookSource(notebook);
    return {
      title: displayPath ? `${verb} cell${cell} in ${displayPath}` : "Edit notebook",
      kind: "edit",
      locations: notebook?.notebook_path ? [{ path: notebook.notebook_path }] : [],
      ...(source ? { display: source } : {}),
    };
  }

  /**
   * The result text repeats the new cell source, which the input holds. A
   * cell deletion has no source, so its result text is the result to show.
   */
  toolResult(context: ToolResultContext): ToolResultFacts {
    return context.capabilities.air.client &&
      notebookSource(context.toolUse.input as Partial<NotebookEditInput>)
      ? { rawOutput: undefined }
      : resultText(context.result);
  }
}

function notebookSource(
  input: Partial<NotebookEditInput> | undefined,
): ToolCallContent[] | undefined {
  if (input?.edit_mode === "delete" || typeof input?.new_source !== "string") return undefined;
  return [textContent(markdownEscape(input.new_source))];
}

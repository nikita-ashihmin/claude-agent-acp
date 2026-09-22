import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  type ContextCompactionMetadata,
  createContextCompactionMeta,
} from "../../context-compaction-meta.js";
import { textContent } from "../content.js";

type CompactionFacts = Omit<ContextCompactionMetadata, "version">;
type ToolCallUpdate = SessionNotification["update"];

const TITLE = "Compact conversation";

/**
 * The synthetic "Compact conversation" tool call, for a client without the
 * ACP compaction updates.
 *
 * A client detects it by `_meta.jetbrains.air.contextCompaction`, which holds
 * the trigger, the token counts, the duration, and the error. The error also
 * goes to `content` once, because it is the result to show. No `rawOutput`
 * repeats the facts.
 */
export const compactionToolCall = {
  started(compactionId: string): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call",
      toolCallId: compactionId,
      title: TITLE,
      kind: "think",
      status: "in_progress",
      _meta: createContextCompactionMeta(),
    };
  },

  inProgress(compactionId: string): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: compactionId,
      status: "in_progress",
      _meta: createContextCompactionMeta(),
    };
  },

  /** The terminal report. A missed opening makes it the first report, a `tool_call`. */
  finished(
    compactionId: string,
    status: "completed" | "failed" | undefined,
    facts: CompactionFacts,
    first: boolean,
  ): ToolCallUpdate {
    const errorContent =
      status === "failed" && facts.error
        ? { content: [textContent(`Compaction failed: ${facts.error}`)] }
        : {};
    if (first) {
      return {
        sessionUpdate: "tool_call",
        toolCallId: compactionId,
        title: TITLE,
        kind: "think",
        status: status ?? "completed",
        ...errorContent,
        _meta: createContextCompactionMeta(facts),
      };
    }
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: compactionId,
      ...(status ? { status } : {}),
      ...errorContent,
      _meta: createContextCompactionMeta(facts),
    };
  },
};

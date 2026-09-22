import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";

type SessionUpdate = SessionNotification["update"];

/**
 * The tool-call fields that a client overwrites when a `tool_call_update`
 * carries them. ACP replaces a present `content` or `locations` list as a
 * whole, and `rawInput` and `rawOutput` are whole values. `status` is not
 * tracked: `tool_progress` changes it outside the tracker, and it is small.
 */
const REPLACED_FIELDS = ["title", "kind", "content", "locations", "rawInput", "rawOutput"] as const;

type ReplacedField = (typeof REPLACED_FIELDS)[number];

interface SentToolCall {
  /** The JSON of each replaced field that the client holds now. */
  fields: Map<ReplacedField, string>;
  /** The `_meta.claudeCode` keys that the client holds now, merged by key. */
  claudeCode: Map<string, string>;
  /** True while an exact approval patch must not be replaced by a snippet. */
  contentPinned: boolean;
  /** True after the tool_result. The entry then waits only for the hook. */
  resultSeen: boolean;
}

/**
 * Remembers what the client holds for each open tool call, so that a
 * `tool_call_update` carries only the fields that changed.
 *
 * A client overwrites a field that an update carries and merges `_meta` by
 * key. An update that repeats a field value therefore only costs bandwidth,
 * and for a Write it repeats the whole file. The tracker drops such fields.
 * It never drops `_meta`, because a client appends `terminal_output_delta`
 * data.
 *
 * An entry starts at the `tool_call` and ends after both the tool_result and
 * the PostToolUse hook callback, or when the session is torn down.
 */
export class ToolCallFieldTracker {
  private readonly calls = new Map<string, SentToolCall>();

  /**
   * Records a `tool_call`, or removes the unchanged fields of a
   * `tool_call_update` and records the rest.
   *
   * Returns false when the update carries nothing new: no replaced field
   * remains, `_meta` has no key besides `claudeCode`, and every `claudeCode`
   * key repeats its value. The caller then skips the update. An update for a
   * tool call that the tracker does not know passes through unchanged.
   *
   * `replacePinnedContent` lets the final result of the tool replace an exact
   * approval patch (see {@link pinContent}).
   */
  apply(update: SessionUpdate, options?: { replacePinnedContent?: boolean }): boolean {
    if (update.sessionUpdate === "tool_call") {
      const entry: SentToolCall = {
        fields: new Map(),
        claudeCode: new Map(),
        contentPinned: false,
        resultSeen: false,
      };
      this.calls.set(update.toolCallId, entry);
      for (const field of REPLACED_FIELDS) {
        const value = (update as Record<string, unknown>)[field];
        if (value !== undefined) entry.fields.set(field, JSON.stringify(value));
      }
      recordClaudeCode(entry, update._meta);
      return true;
    }
    if (update.sessionUpdate !== "tool_call_update") return true;
    const entry = this.calls.get(update.toolCallId);
    if (!entry) return true;

    const fields = update as Record<string, unknown>;
    let changed = false;
    for (const field of REPLACED_FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      if (field === "content" && entry.contentPinned) {
        if (!options?.replacePinnedContent) {
          delete fields[field];
          continue;
        }
        entry.contentPinned = false;
      }
      const json = JSON.stringify(value);
      if (entry.fields.get(field) === json) {
        delete fields[field];
        continue;
      }
      entry.fields.set(field, json);
      changed = true;
    }
    const meta = update._meta;
    if (meta && Object.keys(meta).some((key) => key !== "claudeCode")) changed = true;
    if (recordClaudeCode(entry, meta)) changed = true;
    return changed;
  }

  /**
   * Records the exact approval patch that the client shows for a tool call.
   *
   * The streamed tool input later refines the call with a standard diff of
   * the Edit snippet. That diff must not replace the exact patch, so the
   * content stays until an update passes `replacePinnedContent`.
   */
  pinContent(toolCallId: string, content: ToolCallContent[]): void {
    const entry = this.calls.get(toolCallId);
    if (!entry) return;
    entry.fields.set("content", JSON.stringify(content));
    entry.contentPinned = true;
  }

  /**
   * Marks the tool_result of a tool call. The entry ends now, or after the
   * PostToolUse hook callback when `hookPending` is true.
   */
  finishResult(toolCallId: string, hookPending: boolean): void {
    const entry = this.calls.get(toolCallId);
    if (!entry) return;
    if (hookPending) entry.resultSeen = true;
    else this.calls.delete(toolCallId);
  }

  /**
   * Marks the end of the PostToolUse hook callback of a tool call. The entry
   * ends when the tool_result was seen. Otherwise the tool_result ends it.
   */
  finishHook(toolCallId: string): void {
    if (this.calls.get(toolCallId)?.resultSeen) this.calls.delete(toolCallId);
  }

  /** Forgets one tool call. */
  delete(toolCallId: string): void {
    this.calls.delete(toolCallId);
  }

  /** Forgets every tool call, when the session is torn down. */
  clear(): void {
    this.calls.clear();
  }

  /** The number of open tool calls. */
  get size(): number {
    return this.calls.size;
  }
}

/** Merges the `claudeCode` keys of `meta`. Returns true when a key changed. */
function recordClaudeCode(
  entry: SentToolCall,
  meta: Record<string, unknown> | null | undefined,
): boolean {
  const claudeCode = meta?.claudeCode;
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) return false;
  let changed = false;
  for (const [key, value] of Object.entries(claudeCode)) {
    const json = JSON.stringify(value);
    if (entry.claudeCode.get(key) === json) continue;
    entry.claudeCode.set(key, json);
    changed = true;
  }
  return changed;
}

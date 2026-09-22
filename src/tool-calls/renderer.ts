import type {
  ClientCapabilities as AcpClientCapabilities,
  RequestPermissionRequest,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
} from "@agentclientprotocol/sdk";
import {
  AIR_COMMAND_TITLE_KEY,
  AIR_SKILL_KEY,
  AIR_SUBAGENT_KEY,
  withAirMeta,
} from "../air-extension.js";
import { ClientCapabilities } from "./client-capabilities.js";
import { resultText, textContent, toAcpContentUpdate, toolResponseMarkers } from "./content.js";
import type { ToolResultContext, ToolResultFacts, ToolUse, ToolUseFacts } from "./facts.js";
import { reporterFor } from "./reporters/index.js";
import { resolveSkillPath } from "./reporters/interaction.js";

export type ToolCallUpdate = SessionNotification["update"];

/** The `_meta` of a tool call report. */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. Also carried as the
       standard ACP `name` field on the initial `tool_call`. */
    toolName: string;
    /* Small structured facts provided by Claude Code. On a PostToolUse update
       only the `status` and `isAsync` markers of the tool_response travel; the
       tool output itself is in the tool-call content. */
    toolResponse?: unknown;
    /* For a tool call made inside a subagent: the tool_use id of the
       Agent/Task call that spawned the subagent. Mirrors the SDK's
       `parent_tool_use_id` on streamed subagent messages. */
    parentToolUseId?: string;
    /* On a "failed" tool_call_update: why the tool never actually ran, so a
       client can render the denial/cancellation distinctly from a real tool
       failure. From the SDK's `tool_result_meta` non_execution_kind:
       "user-rejected", "permission-rule", "interrupted", "cancelled", …
       (open set). Absent when the tool executed — including real failures. */
    nonExecutionKind?: string;
    /* Free-text the user supplied when rejecting the tool call, when the
       harness collected any. Only ever present alongside nonExecutionKind. */
    userFeedback?: string;
    /* The MCP server of an `mcp__*` tool, on a permission request. */
    mcpServer?: { name: string; source: string };
  };
  /* The AIR client flags of the ACP tool call contract (`docs/acp-tool-call-contract.md`). */
  jetbrains?: {
    air?: {
      version?: number;
      /* The concise description of a shell command, kept out of the
         standard `title`, which clients use as the command preview. */
      commandTitle?: string;
      /* Marks Agent/Task tool calls as subagent launches. ACP has no standard
         subagent ToolKind yet. */
      subagent?: true;
      /* For Skill tool calls: the skill name, and the absolute path of its
         SKILL.md when it could be located on disk. */
      skill?: { name: string; path?: string };
      [key: string]: unknown;
    };
  };
  /* `true` for an MCP tool call. */
  is_mcp_tool_call?: true;
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_output_delta?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

/** The result fields of a tool call report, before the status and the tool name. */
export interface RenderedResult {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  /** Present when the reporter decided the raw output. */
  rawOutput?: unknown;
  _meta?: Pick<
    ToolUpdateMeta,
    "terminal_info" | "terminal_output" | "terminal_output_delta" | "terminal_exit"
  >;
}

/** The SDK tool_result block that a result report reads. */
type ResultBlock = ToolResultContext["result"];

/**
 * Turns tool facts into the fields of the standard ACP tool call report, as
 * `docs/acp-tool-call-contract.md` defines: each fact goes in one field.
 *
 * The {@link ToolReporter} of the tool reads the SDK data. The renderer
 * decides the fields from the facts and the {@link ClientCapabilities}. The
 * {@link ToolCallFieldTracker} runs after it and drops the fields that an
 * earlier report of the same tool call already sent.
 */
export class AcpToolCallRenderer {
  constructor(readonly capabilities: ClientCapabilities = new ClientCapabilities()) {}

  static for(capabilities: AcpClientCapabilities | null | undefined): AcpToolCallRenderer {
    return new AcpToolCallRenderer(ClientCapabilities.from(capabilities));
  }

  /** The facts of a tool use. */
  facts(toolUse: Pick<ToolUse, "name" | "input">, cwd?: string): ToolUseFacts {
    return reporterFor(toolUse.name).toolUse(toolUse.input, {
      cwd,
      capabilities: this.capabilities,
    });
  }

  /** The standard fields of a tool use: the title, the kind, the content, and the locations. */
  toolInfo(
    toolUse: ToolUse,
    cwd?: string,
  ): {
    title: string;
    kind: ToolUseFacts["kind"];
    content: ToolCallContent[];
    locations?: ToolCallLocation[];
  } {
    const facts = this.facts(toolUse, cwd);
    return {
      title: facts.title,
      kind: facts.kind,
      content: this.toolUseContent(toolUse.id, facts),
      ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
    };
  }

  /**
   * The first report of a tool call. `rawInput` is left out while the input
   * still streams: the consolidated message sends it once it is complete.
   */
  toolCall(
    toolUse: ToolUse,
    options: { cwd?: string; inputComplete?: boolean; previewContent?: ToolCallContent[] } = {},
  ): ToolCallUpdate {
    const facts = this.facts(toolUse, options.cwd);
    const isMcp = toolUse.name.startsWith("mcp__");
    return {
      _meta: {
        ...toolUseMeta(toolUse, options.cwd),
        ...(facts.command && this.capabilities.terminalOutput
          ? { terminal_info: { terminal_id: toolUse.id } }
          : {}),
        ...(isMcp ? { is_mcp_tool_call: true } : {}),
      } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call",
      name: toolUse.name,
      ...(options.inputComplete === false ? {} : { rawInput: this.rawInput(facts, toolUse.input) }),
      status: "pending",
      title: facts.title,
      kind: facts.kind,
      content: options.previewContent ?? this.toolUseContent(toolUse.id, facts),
      ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
    };
  }

  /** The report of a tool call whose input is complete now. */
  refinement(toolUse: ToolUse, cwd?: string): ToolCallUpdate {
    const facts = this.facts(toolUse, cwd);
    return {
      _meta: toolUseMeta(toolUse, cwd),
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      rawInput: this.rawInput(facts, toolUse.input),
      title: facts.title,
      kind: facts.kind,
      content: this.toolUseContent(toolUse.id, facts),
      ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
    };
  }

  /**
   * The report of a tool call from the complete top-level fields of its still
   * streaming input. It carries neither `rawInput`, which goes out once it is
   * complete, nor content: content built from partial input is misleading (an
   * Edit without its `new_string` renders as a deletion) or invalid.
   */
  partialRefinement(toolUse: Pick<ToolUse, "id" | "name">, input: unknown, cwd?: string) {
    const facts = this.facts({ name: toolUse.name, input }, cwd);
    return {
      _meta: toolUseMeta({ name: toolUse.name, input }, cwd),
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      title: facts.title,
      kind: facts.kind,
      ...(facts.locations ? { locations: facts.locations } : {}),
    } satisfies ToolCallUpdate;
  }

  /**
   * The tool call of a permission request: `toolCallId`, `title`, and
   * `rawInput`. The client already holds the rest. The request adds only what
   * it shows new: an exact preview patch, and a location that the tool call
   * does not have.
   */
  permissionToolCall(
    toolUse: ToolUse,
    options: {
      cwd?: string;
      title?: string;
      previewContent?: ToolCallContent[];
      extraLocations?: ToolCallLocation[];
      meta?: ToolUpdateMeta;
    } = {},
  ): RequestPermissionRequest["toolCall"] {
    const facts = this.facts(toolUse, options.cwd);
    return {
      toolCallId: toolUse.id,
      title: options.title ?? facts.title,
      rawInput: this.rawInput(facts, toolUse.input),
      ...(options.previewContent ? { content: options.previewContent } : {}),
      ...(options.extraLocations?.length
        ? { locations: [...(facts.locations ?? []), ...options.extraLocations] }
        : {}),
      ...(options.meta ? { _meta: options.meta } : {}),
    };
  }

  /** The facts of a tool result. */
  resultFacts(toolUse: ToolUse, result: ResultBlock, structured?: unknown): ToolResultFacts {
    const reporter = reporterFor(toolUse.name);
    const context: ToolResultContext = {
      toolUse,
      result,
      structured,
      capabilities: this.capabilities,
    };
    const content = result.content;
    const hasErrorText =
      result.is_error === true &&
      content !== undefined &&
      content !== null &&
      (typeof content === "string" || Array.isArray(content)) &&
      content.length > 0;
    if (hasErrorText) {
      return reporter.errorResult?.(context) ?? toAcpContentUpdate(content, true);
    }
    return reporter.toolResult ? reporter.toolResult(context) : resultText(result);
  }

  /** The result fields of a tool result, before the status and the tool name. */
  resultFields(toolUse: ToolUse, result: ResultBlock, structured?: unknown): RenderedResult {
    const facts = this.resultFacts(toolUse, result, structured);
    const { command, ...fields } = facts;
    if (!command) return fields;
    // The terminal was announced under the tool_use id (see `toolCall`), so the
    // output keys off that id. A non-string id is no id at all.
    const idOf = (id: unknown) => (typeof id === "string" && id.length > 0 ? id : undefined);
    const terminalId = idOf(toolUse.id) ?? idOf(result.tool_use_id);
    // Without a terminal id nothing can match the output. A client that
    // buffers output for an unknown terminal would hold it forever, so the
    // output becomes a code block instead.
    if (this.capabilities.terminalOutput && terminalId !== undefined) {
      const output = { terminal_id: terminalId, data: command.output };
      return {
        ...fields,
        _meta: {
          terminal_info: { terminal_id: terminalId },
          ...(this.capabilities.terminalOutputDelta
            ? { terminal_output_delta: output }
            : { terminal_output: output }),
          terminal_exit: { terminal_id: terminalId, exit_code: command.exitCode, signal: null },
        },
      };
    }
    return command.output.trim()
      ? {
          ...fields,
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: `\`\`\`console\n${command.output.trimEnd()}\n\`\`\``,
              },
            },
          ],
        }
      : fields;
  }

  /**
   * The reports of a tool result. A command sends its output as a separate
   * report first, like codex-acp: the output, then the exit and the status.
   * The output travels once: the raw tool_result goes to `rawOutput` only
   * when no other field carries the result.
   */
  result(
    toolUse: ToolUse,
    result: ResultBlock,
    options: { structured?: unknown; nonExecution?: Record<string, unknown> } = {},
  ): ToolCallUpdate[] {
    const { _meta: resultMeta, ...fields } = this.resultFields(toolUse, result, options.structured);
    const updates: ToolCallUpdate[] = [];
    const terminalOutput = resultMeta?.terminal_output_delta ?? resultMeta?.terminal_output;
    if (terminalOutput) {
      updates.push({
        _meta: resultMeta?.terminal_output_delta
          ? { terminal_output_delta: terminalOutput }
          : { terminal_output: terminalOutput },
        toolCallId: toolUse.id,
        sessionUpdate: "tool_call_update",
      });
    }
    const rawOutput =
      "rawOutput" in fields
        ? fields.rawOutput
        : terminalOutput || fields.content !== undefined
          ? undefined
          : result.content;
    delete fields.rawOutput;
    updates.push({
      _meta: {
        claudeCode: { toolName: toolUse.name, ...(options.nonExecution ?? {}) },
        ...(resultMeta?.terminal_exit ? { terminal_exit: resultMeta.terminal_exit } : {}),
      } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      status: result.is_error === true ? "failed" : "completed",
      ...(rawOutput !== undefined ? { rawOutput } : {}),
      ...fields,
    });
    return updates;
  }

  /**
   * The report of a PostToolUse hook: the final change of an edit tool, and
   * the `status` and `isAsync` markers of the `tool_response`. The rest of the
   * `tool_response` repeats output that the content already carries.
   */
  async hookResult(
    toolUse: Pick<ToolUse, "id" | "name">,
    toolResponse: unknown,
    cwd?: string,
  ): Promise<ToolCallUpdate | undefined> {
    const reporter = reporterFor(toolUse.name);
    const change = reporter.hookResult
      ? await reporter.hookResult(toolResponse, { cwd, capabilities: this.capabilities })
      : {};
    const markers = toolResponseMarkers(toolResponse);
    if (!markers && !change.content && !change.locations) return undefined;
    return {
      _meta: {
        claudeCode: { ...(markers ? { toolResponse: markers } : {}), toolName: toolUse.name },
      } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      ...(change.content ? { content: change.content } : {}),
      ...(change.locations ? { locations: change.locations } : {}),
    };
  }

  /**
   * The report of a memory recall: a completed read tool call. A synthesis
   * shows the recalled text, a plain recall shows the memory files.
   */
  memoryRecall(recall: {
    uuid: string;
    mode: string;
    memories: { path: string; content?: string }[];
  }): ToolCallUpdate {
    const isSynthesis = recall.mode === "synthesize";
    const locations = isSynthesis ? [] : recall.memories.map((memory) => ({ path: memory.path }));
    const content = isSynthesis
      ? recall.memories.flatMap((memory) =>
          typeof memory.content === "string" ? [textContent(memory.content)] : [],
        )
      : [];
    const count = recall.memories.length;
    return {
      sessionUpdate: "tool_call",
      toolCallId: recall.uuid,
      title: isSynthesis
        ? "Recalled synthesized memory"
        : `Recalled ${count} ${count === 1 ? "memory" : "memories"}`,
      kind: "read",
      status: "completed",
      ...(locations.length > 0 && { locations }),
      ...(content.length > 0 && { content }),
      _meta: {
        claudeCode: { toolName: "memory_recall", toolResponse: { mode: recall.mode } },
      } satisfies ToolUpdateMeta,
    };
  }

  /**
   * The report of a tool call that a rule, the classifier, or a mode denied
   * before it ran. The reason is the result to show, so `toolResponse` keeps
   * only the reason type, and the SDK message when it differs from the reason.
   */
  permissionDenied(denial: {
    toolCallId: string;
    toolName: string;
    parentToolUseId?: string;
    decisionReasonType?: string;
    decisionReason?: string;
    message?: string;
  }): ToolCallUpdate {
    const reason = denial.decisionReason ?? denial.message;
    const extraMessage =
      denial.decisionReason !== undefined &&
      denial.message !== undefined &&
      denial.message !== denial.decisionReason
        ? { message: denial.message }
        : {};
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: denial.toolCallId,
      status: "failed",
      content: [textContent(`Permission denied: ${reason}`)],
      _meta: {
        claudeCode: {
          toolName: denial.toolName,
          ...(denial.parentToolUseId ? { parentToolUseId: denial.parentToolUseId } : {}),
          toolResponse: { decisionReasonType: denial.decisionReasonType, ...extraMessage },
        },
      } satisfies ToolUpdateMeta,
    };
  }

  /**
   * The report of a tool progress beat. The field tracker sends the
   * `in_progress` status once, so a later beat carries only the progress.
   */
  progress(beat: {
    toolCallId: string;
    toolName: string;
    parentToolUseId?: string;
    elapsedTimeSeconds: number;
    subagentType?: string;
    subagentRetry?: unknown;
  }): ToolCallUpdate {
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: beat.toolCallId,
      status: "in_progress",
      _meta: {
        claudeCode: {
          toolName: beat.toolName,
          ...(beat.parentToolUseId ? { parentToolUseId: beat.parentToolUseId } : {}),
          toolResponse: {
            elapsedTimeSeconds: beat.elapsedTimeSeconds,
            // For Agent/Task calls: the subagent type, and the SDK retry
            // counters while the subagent waits out an API rate limit, so a
            // client can show why a spawn looks stalled.
            ...(beat.subagentType !== undefined && { subagentType: beat.subagentType }),
            ...(beat.subagentRetry !== undefined && { subagentRetry: beat.subagentRetry }),
          },
        },
      } satisfies ToolUpdateMeta,
    };
  }

  /** `rawInput` without the file text that the diff holds. */
  rawInput(facts: ToolUseFacts, rawInput: unknown): unknown {
    if (
      !facts.change?.length ||
      !facts.fileTextKeys ||
      !rawInput ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput)
    ) {
      return rawInput;
    }
    const input = { ...(rawInput as Record<string, unknown>) };
    for (const key of facts.fileTextKeys) delete input[key];
    return input;
  }

  /**
   * The content of a tool use. A command shows the terminal marker. An edit
   * shows its change. A display copy of the input goes only to a client that
   * does not render `rawInput` itself, and never next to a terminal.
   */
  toolUseContent(toolCallId: string, facts: ToolUseFacts): ToolCallContent[] {
    const terminal = facts.command === true && this.capabilities.terminalOutput;
    return [
      ...(terminal ? [{ type: "terminal" as const, terminalId: toolCallId }] : []),
      ...(facts.change ?? []),
      ...(!terminal && !this.capabilities.air.rawInputRendering ? (facts.display ?? []) : []),
    ];
  }
}

/**
 * The `_meta` of a tool use report: the tool name, and the AIR client flags.
 * A shell description stays out of the standard `title`, which clients use as
 * the command preview, and travels as `_meta.jetbrains.air.commandTitle`.
 */
export function toolUseMeta(
  toolUse: { name: string; input?: unknown },
  cwd?: string,
): ToolUpdateMeta {
  const input =
    toolUse.input !== null && typeof toolUse.input === "object"
      ? (toolUse.input as Record<string, unknown>)
      : {};
  const description =
    (toolUse.name === "Bash" || toolUse.name === "PowerShell") &&
    typeof input.description === "string"
      ? input.description
      : undefined;
  const skillName =
    toolUse.name === "Skill" && typeof input.skill === "string" ? input.skill : undefined;
  let meta: Record<string, unknown> = { claudeCode: { toolName: toolUse.name } };
  if (description) meta = withAirMeta(meta, AIR_COMMAND_TITLE_KEY, description);
  if (toolUse.name === "Agent" || toolUse.name === "Task") {
    meta = withAirMeta(meta, AIR_SUBAGENT_KEY, true);
  }
  if (skillName) {
    const skillPath = resolveSkillPath(skillName, cwd);
    meta = withAirMeta(meta, AIR_SKILL_KEY, {
      name: skillName,
      ...(skillPath ? { path: skillPath } : {}),
    });
  }
  return meta as ToolUpdateMeta;
}

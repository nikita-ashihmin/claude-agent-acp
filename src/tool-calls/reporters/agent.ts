import type { AgentInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { AgentOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { structuredResult, textContent, toAcpContentUpdate } from "../content.js";
import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";

/** Agent and Task: a subagent. Its prompt is input that the user reads. */
export class AgentReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const agent = input as Partial<AgentInput> | undefined;
    return {
      title: agent?.description ? agent.description : "Task",
      kind: "think",
      ...(typeof agent?.prompt === "string" ? { display: [textContent(agent.prompt)] } : {}),
    };
  }

  toolResult({ result, structured }: ToolResultContext): ToolResultFacts {
    const isError = result.is_error === true;
    // The raw tool_result text ends with a model-directed trailer (an
    // `agentId: … (use SendMessage …)` line and a `<usage>` block). The
    // structured AgentOutput carries the report without it. Render from it
    // when present, and fall back to the raw text (older CLIs, replay).
    const report = structuredResult<AgentOutput>(structured);
    if (
      report?.status === "completed" &&
      Array.isArray(report.content) &&
      // A completed subagent can end with zero text blocks. The raw text is
      // then the better render.
      report.content.length > 0
    ) {
      return toAcpContentUpdate(replacePartialOutputNote(report.content), isError);
    }
    return toAcpContentUpdate(
      replacePartialOutputNote(stripAgentTrailerFromContent(result.content)),
      isError,
    );
  }
}

/**
 * Strip the model-directed trailer from a raw Agent/Task tool_result text:
 * a `<usage>…</usage>` totals block and/or an
 * `agentId: <id> (use SendMessage …)` continuation line at the end of the
 * text. Both patterns are tail-anchored and independent (older CLIs emit
 * variants with only one of them), so a format change makes them stop
 * matching rather than mangle the report.
 */
function stripAgentTrailer(text: string): string {
  return stripAgentIdLine(stripUsageBlock(text));
}

const USAGE_OPEN = "<usage>";
const USAGE_CLOSE = "</usage>";

/** Remove a trailing `<usage>…</usage>` block, plus trailing whitespace and
 *  one preceding newline. Matches from the *last* `<usage>` so a report that
 *  merely mentions the marker earlier isn't truncated at the mention. */
function stripUsageBlock(text: string): string {
  const body = text.trimEnd();
  if (!body.endsWith(USAGE_CLOSE)) {
    return text;
  }
  const open = body.lastIndexOf(USAGE_OPEN, body.length - USAGE_CLOSE.length - USAGE_OPEN.length);
  if (open === -1) {
    return text;
  }
  return body.slice(0, open > 0 && body[open - 1] === "\n" ? open - 1 : open);
}

/** The continuation line, anchored to a whole line so the regex has a single
 *  start position and no ambiguous repetition (`[\w-]+` can't consume the
 *  following space, `[^)]*` can't consume the closing paren) — it runs in
 *  linear time on any input. */
const AGENT_ID_LINE = /^agentId: [\w-]+ \([^)]*\)$/;

/** Remove a final `agentId: <id> (…)` line, plus trailing whitespace and the
 *  newline that preceded the line. */
function stripAgentIdLine(text: string): string {
  const body = text.trimEnd();
  const lineStart = body.lastIndexOf("\n") + 1;
  if (!AGENT_ID_LINE.test(body.slice(lineStart))) {
    return text;
  }
  return body.slice(0, Math.max(lineStart - 1, 0));
}

/** Apply {@link stripAgentTrailer} across a raw tool_result `content` (plain
 *  string or block array), leaving non-text blocks untouched. */
function stripAgentTrailerFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripAgentTrailer(content);
  }
  if (Array.isArray(content)) {
    return content.map((block) =>
      block !== null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
        ? { ...block, text: stripAgentTrailer(block.text) }
        : block,
    );
  }
  return content;
}

/** Leading model-directed note the CLI prepends to a subagent's report when
 *  the agent stopped at its maxTurns limit (CLI 2.1.246+); the result still
 *  ships as `status: "completed"`. Two body variants follow this prefix, and
 *  the trailing "Send the agent a message (SendMessage) …" sentence is
 *  omitted for some agent types — anchor only the stable prefix so a format
 *  change makes the replacement stop matching rather than mangle a report. */
const PARTIAL_OUTPUT_NOTE = /^NOTE: this agent stopped at its \d+-turn limit before finishing\./;

/** Client-facing replacement: the partial-output fact matters to the user,
 *  but the SendMessage continuation instruction is model-directed and
 *  meaningless over ACP. */
const PARTIAL_OUTPUT_LABEL = "[Agent stopped at its turn limit — the output below is partial]";

/** Replace a leading partial-output note paragraph with the concise
 *  client-facing label, leaving the report that follows intact. */
function replacePartialNoteInText(text: string): string {
  if (!PARTIAL_OUTPUT_NOTE.test(text)) return text;
  const paragraphEnd = text.indexOf("\n\n");
  const report = paragraphEnd === -1 ? "" : text.slice(paragraphEnd + 2).trimStart();
  return report ? `${PARTIAL_OUTPUT_LABEL}\n\n${report}` : PARTIAL_OUTPUT_LABEL;
}

/** Apply {@link replacePartialNoteInText} to an Agent/Task result `content`.
 *  In the structured AgentOutput lane the note is its own leading text block;
 *  in the raw lane it is the first paragraph of the text — both reduce to
 *  transforming the first text block (or the plain string). */
function replacePartialOutputNote(content: unknown): unknown {
  if (typeof content === "string") {
    return replacePartialNoteInText(content);
  }
  if (Array.isArray(content) && content.length > 0) {
    const [first, ...rest] = content;
    if (
      first !== null &&
      typeof first === "object" &&
      first.type === "text" &&
      typeof first.text === "string"
    ) {
      return [{ ...first, text: replacePartialNoteInText(first.text) }, ...rest];
    }
  }
  return content;
}

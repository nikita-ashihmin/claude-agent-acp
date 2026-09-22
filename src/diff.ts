import { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { createTwoFilesPatch } from "diff";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AIR_DIFF_PATCH_CAPABILITY, withAirMeta } from "./air-extension.js";

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
  /** FileWriteOutput only (FileEditOutput carries no `type`): whether the
   *  write created the file or overwrote an existing one. */
  type?: "create" | "update";
  /** FileWriteOutput only: the content that was written. */
  content?: string;
  /** FileWriteOutput only: the pre-write content — null on create, or on an
   *  update whose previous content was too large to include. */
  originalFile?: string | null;
}

interface EditPreviewInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

interface WritePreviewInput {
  file_path?: unknown;
  content?: unknown;
}

/** Builds the patch shown before Claude runs an Edit or Write tool. */
export async function previewPatchContent(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): Promise<ToolCallContent[] | undefined> {
  if (toolName === "Edit") {
    const edit = input as EditPreviewInput;
    if (
      typeof edit.file_path !== "string" ||
      typeof edit.old_string !== "string" ||
      edit.old_string.length === 0 ||
      typeof edit.new_string !== "string"
    ) {
      return [];
    }
    const filePath = resolveToolPath(edit.file_path, cwd);
    const oldText = await readFile(filePath, "utf8").catch(() => undefined);
    if (oldText === undefined) return [];
    const occurrences = oldText.split(edit.old_string).length - 1;
    if (occurrences === 0 || (edit.replace_all !== true && occurrences !== 1)) return [];
    const newText =
      edit.replace_all === true
        ? oldText.split(edit.old_string).join(edit.new_string)
        : oldText.replace(edit.old_string, () => edit.new_string as string);
    return [patchContent(filePath, createGitPatch(filePath, oldText, newText))];
  }

  if (toolName === "Write") {
    const write = input as WritePreviewInput;
    if (typeof write.file_path !== "string" || typeof write.content !== "string") return [];
    const filePath = resolveToolPath(write.file_path, cwd);
    const oldText = await readFile(filePath, "utf8").catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      return undefined;
    });
    if (oldText === undefined || oldText === write.content) return [];
    return [patchContent(filePath, createGitPatch(filePath, oldText, write.content))];
  }

  return undefined;
}

/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export function toolUpdateFromDiffToolResponse(
  toolResponse: unknown,
  supportsDiffPatch = false,
): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  if (supportsDiffPatch && response.structuredPatch.length > 0) {
    const text = structuredGitPatch(response.filePath, response.structuredPatch, response.type);
    if (text) {
      return {
        content: [patchContent(response.filePath, text)],
        locations: response.structuredPatch.map(({ newStart }) => ({
          path: response.filePath!,
          line: newStart,
        })),
      };
    }
  }

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];
  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else if (line === "\\ No newline at end of file") {
        continue;
      } else {
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
      });
    }
  }

  // A Write `update` can arrive with an empty structuredPatch — nothing
  // changed, the diff timed out, or the previous content was too large to
  // diff (originalFile null; SDK 0.3.252 documents the lane). Returning `{}`
  // would leave Write's optimistic tool_use-time content standing, and that
  // was built with `oldText: null` — "creation" semantics — so an overwrite
  // of a large existing file would render as creating it. Emit a truthful
  // replacement instead. Gated on `type` so Edit (whose output carries no
  // `type` and whose optimistic old/new diff is already truthful) keeps the
  // empty-return behavior.
  if (
    content.length === 0 &&
    (response.type === "update" || (supportsDiffPatch && response.type === "create")) &&
    typeof response.content === "string"
  ) {
    locations.push({ path: response.filePath });
    content.push(
      supportsDiffPatch && (response.type === "create" || typeof response.originalFile === "string")
        ? patchContentFromTexts(
            response.filePath,
            response.type === "create" ? null : response.originalFile!,
            response.content,
          )
        : typeof response.originalFile === "string"
          ? {
              type: "diff",
              path: response.filePath,
              oldText: response.originalFile,
              newText: response.content,
            }
          : {
              type: "content",
              content: {
                type: "text",
                text: `Updated \`${response.filePath}\` (previous content too large to diff)`,
              },
            },
    );
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}

export function patchContentFromTexts(
  filePath: string,
  oldText: string | null,
  newText: string | null,
): ToolCallContent {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldRange = oldLines.length === 0 ? "0,0" : `1,${oldLines.length}`;
  const newRange = newLines.length === 0 ? "0,0" : `1,${newLines.length}`;
  const text = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- ${oldText === null ? "/dev/null" : `a/${filePath}`}`,
    `+++ ${newText === null ? "/dev/null" : `b/${filePath}`}`,
    `@@ -${oldRange} +${newRange} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
  return patchContent(filePath, text);
}

function structuredGitPatch(
  filePath: string,
  hunks: DiffToolResponseHunk[],
  type?: "create" | "update",
): string | undefined {
  if (hunks.some((hunk) => !validHunk(hunk))) return undefined;
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- ${type === "create" ? "/dev/null" : `a/${filePath}`}`,
    `+++ b/${filePath}`,
    ...hunks.flatMap(({ oldStart, oldLines, newStart, newLines, lines }) => [
      `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@`,
      ...lines,
    ]),
    "",
  ].join("\n");
}

function validHunk(hunk: DiffToolResponseHunk): boolean {
  return (
    [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isSafeInteger) &&
    hunk.oldStart >= 0 &&
    hunk.oldLines >= 0 &&
    hunk.newStart >= 0 &&
    hunk.newLines >= 0 &&
    hunk.lines.every(
      (line) =>
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line === "\\ No newline at end of file",
    )
  );
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function patchContent(filePath: string, text: string): ToolCallContent {
  return {
    type: "diff",
    path: filePath,
    oldText: null,
    newText: "",
    _meta: withAirMeta(undefined, AIR_DIFF_PATCH_CAPABILITY, {
      version: 1,
      format: "git_patch",
      text,
    }),
  };
}

function splitLines(text: string | null): string[] {
  if (!text) return [];
  return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(/\n$/u, "").split("\n");
}

function resolveToolPath(filePath: string, cwd?: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd ?? process.cwd(), filePath);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function createGitPatch(filePath: string, oldText: string | null, newText: string | null): string {
  const patchPath = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const oldPath = `a/${patchPath}`;
  const newPath = `b/${patchPath}`;
  const unified = createTwoFilesPatch(oldPath, newPath, oldText ?? "", newText ?? "", "", "", {
    context: 3,
  });
  const body = unified
    .replace(/^={3,}\n/u, "")
    .replace(/^--- [^\n]*/u, `--- ${oldText === null ? "/dev/null" : oldPath}`)
    .replace(/^\+\+\+ [^\n]*/mu, `+++ ${newText === null ? "/dev/null" : newPath}`);
  return `diff --git ${oldPath} ${newPath}\n${body}`;
}

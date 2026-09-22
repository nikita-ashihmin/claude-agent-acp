import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { previewPatchContent, toolUpdateFromDiffToolResponse } from "../diff.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryFile(content?: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-acp-patch-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, "file.ts");
  if (content !== undefined) await writeFile(filePath, content);
  return filePath;
}

function patchText(content: Awaited<ReturnType<typeof previewPatchContent>>): string {
  const block = content?.[0];
  if (!block || block.type !== "diff") throw new Error("Expected diff content");
  return (block._meta as any).jetbrains.air.diffPatch.text;
}

describe("diff patches", () => {
  it("builds a compact approval patch from a 12000-line file", async () => {
    const lines = Array.from({ length: 12_000 }, (_, index) => `line ${index + 1}`);
    const filePath = await temporaryFile(`${lines.join("\n")}\n`);
    const content = await previewPatchContent("Edit", {
      file_path: filePath,
      old_string: "line 6000",
      new_string: "changed line",
    });

    expect(content?.[0]).toMatchObject({ type: "diff", oldText: null, newText: "" });
    const patch = patchText(content);
    expect(patch).toContain("-line 6000");
    expect(patch).toContain("+changed line");
    expect(patch).not.toContain("line 1000\n");
  });

  it("builds an approval patch for every replace_all occurrence", async () => {
    const filePath = await temporaryFile("old\nmiddle\nold\n");
    const patch = patchText(
      await previewPatchContent("Edit", {
        file_path: filePath,
        old_string: "old",
        new_string: "new",
        replace_all: true,
      }),
    );

    expect(patch.match(/-old/gu)).toHaveLength(2);
    expect(patch.match(/\+new/gu)).toHaveLength(2);
  });

  it("builds update and creation approval patches for Write", async () => {
    const existing = await temporaryFile("before\n");
    const missing = await temporaryFile();

    const update = patchText(
      await previewPatchContent("Write", {
        file_path: existing,
        content: "after\n",
      }),
    );
    const creation = patchText(
      await previewPatchContent("Write", {
        file_path: missing,
        content: "created\n",
      }),
    );

    expect(update).toContain("-before");
    expect(update).toContain("+after");
    expect(creation).toContain("--- /dev/null");
    expect(creation).toContain("+created");
    expect(
      await previewPatchContent("Write", {
        file_path: existing,
        content: "before\n",
      }),
    ).toEqual([]);
  });

  it("omits a preview when an Edit cannot identify one replacement", async () => {
    const filePath = await temporaryFile("same\nsame\n");

    expect(
      await previewPatchContent("Edit", {
        file_path: filePath,
        old_string: "same",
        new_string: "new",
      }),
    ).toEqual([]);
  });

  it("combines all file hunks into one compact git patch", () => {
    const result = toolUpdateFromDiffToolResponse(
      {
        filePath: "/file.ts",
        type: "update",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
          { oldStart: 10, oldLines: 0, newStart: 10, newLines: 1, lines: ["+extra"] },
        ],
      },
      true,
    );

    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]).toMatchObject({
      type: "diff",
      path: "/file.ts",
      oldText: null,
      newText: "",
      _meta: {
        jetbrains: {
          air: {
            version: 1,
            diffPatch: { version: 1, format: "git_patch" },
          },
        },
      },
    });
    const text = (result.content?.[0]._meta as any).jetbrains.air.diffPatch.text;
    expect(text).toContain("@@ -1 +1 @@");
    expect(text).toContain("@@ -10,0 +10 @@");
  });

  it("falls back to old and new text when a negotiated patch cannot be built", () => {
    const result = toolUpdateFromDiffToolResponse(
      {
        filePath: "/file.ts",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["?unsupported"],
          },
        ],
      },
      true,
    );

    expect(result.content).toEqual([
      {
        type: "diff",
        path: "/file.ts",
        oldText: "unsupported",
        newText: "unsupported",
      },
    ]);
  });
});

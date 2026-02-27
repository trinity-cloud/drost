import { describe, expect, it } from "vitest";
import { renderMarkdownToTerminal } from "@drost/tui";

describe("renderMarkdownToTerminal", () => {
  it("formats headings, emphasis, links, and quotes", () => {
    const markdown = [
      "# Project Update",
      "",
      "- **Status**: _green_",
      "- Docs: [readme](https://example.com/readme)",
      "> Keep shipping"
    ].join("\n");

    expect(renderMarkdownToTerminal(markdown)).toBe(
      [
        "PROJECT UPDATE",
        "",
        "- Status: green",
        "- Docs: readme (https://example.com/readme)",
        "| Keep shipping"
      ].join("\n")
    );
  });

  it("renders fenced code blocks as indented literal text", () => {
    const markdown = [
      "Before:",
      "```ts",
      "const x = 1;",
      "console.log(x);",
      "```",
      "After"
    ].join("\n");

    expect(renderMarkdownToTerminal(markdown)).toBe(
      [
        "Before:",
        "    const x = 1;",
        "    console.log(x);",
        "",
        "After"
      ].join("\n")
    );
  });
});

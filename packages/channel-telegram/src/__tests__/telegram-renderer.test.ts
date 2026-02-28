import { describe, expect, it } from "vitest";
import {
  renderTelegramFinalMessage,
  renderTelegramStreamingPreview,
  stripTelegramHtml
} from "../telegram-renderer.js";

describe("telegram renderer", () => {
  it("renders markdown to safe streaming preview and strips tool protocol lines", () => {
    const preview = renderTelegramStreamingPreview([
      "TOOL_CALL {\"name\":\"file\",\"input\":{\"action\":\"read\"}}",
      "# Title",
      "",
      "- **Bold** and _italic_",
      "",
      "`code` and [link](https://example.com)"
    ].join("\n"));

    expect(preview).toContain("TITLE");
    expect(preview).toContain("- Bold and italic");
    expect(preview).toContain("'code' and link (https://example.com)");
    expect(preview).not.toContain("TOOL_CALL");
  });

  it("renders final markdown as Telegram HTML", () => {
    const renderedChunks = renderTelegramFinalMessage([
      "## Heading",
      "",
      "Use **bold**, _italics_, ~~strike~~, and `inline code`.",
      "",
      "[OpenAI](https://openai.com)"
    ].join("\n"));

    const rendered = renderedChunks[0]!;
    expect(rendered.parseMode).toBe("HTML");
    expect(rendered.text).toContain("<b>Heading</b>");
    expect(rendered.text).toContain("<b>bold</b>");
    expect(rendered.text).toContain("<i>italics</i>");
    expect(rendered.text).toContain("<s>strike</s>");
    expect(rendered.text).toContain("<code>inline code</code>");
    expect(rendered.text).toContain("<a href=\"https://openai.com\">OpenAI</a>");
  });

  it("chunks html output when it exceeds max size", () => {
    const source = `# Heading\n\n${"x".repeat(5000)}`;
    const renderedChunks = renderTelegramFinalMessage(source, {
      maxHtmlChars: 800
    });

    expect(renderedChunks.length).toBeGreaterThan(1);
    expect(renderedChunks[0]!.parseMode).toBe("HTML");
    expect(renderedChunks[0]!.text.length).toBeGreaterThan(0);
  });

  it("strips html tags from fallback text", () => {
    expect(stripTelegramHtml("<b>Bold &amp; Bright</b>")).toBe("Bold & Bright");
  });
});


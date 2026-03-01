import { describe, expect, it } from "vitest";
import { parseToolCall } from "../providers/manager/tool-calls.js";

describe("tool call parsing", () => {
  it("parses TOOL_CALL json payloads", () => {
    const parsed = parseToolCall(
      "TOOL_CALL {\"name\":\"web_search\",\"input\":{\"query\":\"Iran\"}}"
    );
    expect(parsed).toEqual({
      toolName: "web_search",
      input: {
        query: "Iran"
      }
    });
  });

  it("parses xai xml function_call payloads", () => {
    const parsed = parseToolCall([
      "Use this:",
      "<xai:function_call name=\"web_search\">",
      "<parameter name=\"action\">search</parameter>",
      "<parameter name=\"query\">Iran</parameter>",
      "</xai:function_call>"
    ].join("\n"), ["web", "code.search"]);

    expect(parsed).toEqual({
      toolName: "web",
      input: {
        action: "search",
        query: "Iran"
      }
    });
  });

  it("infers tool name from available tools for xai xml payloads", () => {
    const parsed = parseToolCall([
      "<xai:function_call>",
      "<parameter name=\"action\">search</parameter>",
      "<parameter name=\"query\">Iran</parameter>",
      "</xai:function_call>"
    ].join("\n"), ["web", "code.search"]);

    expect(parsed).toEqual({
      toolName: "web",
      input: {
        action: "search",
        query: "Iran"
      }
    });
  });
});

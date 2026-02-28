import { describe, expect, it } from "vitest";
import type { ToolContext } from "../index.js";
import { createDefaultBuiltInTools } from "../index.js";

const toolContext: ToolContext = {
  workspaceDir: process.cwd(),
  mutableRoots: [process.cwd()],
  sessionId: "local",
  providerId: "test"
};

function getWebTool(fetchImpl?: typeof fetch) {
  const webTool = createDefaultBuiltInTools({ fetchImpl }).find((tool) => tool.name === "web");
  if (!webTool) {
    throw new Error("web tool is not available");
  }
  return webTool;
}

describe("web tool search", () => {
  it("uses Exa search with EXA_API_KEY", async () => {
    const previous = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-test-key";

    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      requestUrl = input.toString();
      requestInit = init;
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Result One",
              url: "https://example.com/one",
              summary: "First summary"
            },
            {
              title: "Result Two",
              url: "https://example.com/two",
              highlights: ["Second highlight"]
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    };

    try {
      const webTool = getWebTool(mockFetch);
      const output = (await webTool.execute(
        {
          action: "search",
          query: "drost",
          limit: 2
        },
        toolContext
      )) as {
        action: string;
        query: string;
        provider: string;
        results: Array<{ title: string; snippet: string; url: string }>;
      };

      expect(requestUrl).toBe("https://api.exa.ai/search");
      expect(requestInit?.method).toBe("POST");

      const headers = new Headers(requestInit?.headers);
      expect(headers.get("x-api-key")).toBe("exa-test-key");
      expect(headers.get("content-type")).toContain("application/json");

      expect(JSON.parse(String(requestInit?.body))).toEqual({
        query: "drost",
        numResults: 2
      });

      expect(output.provider).toBe("exa");
      expect(output.results).toEqual([
        {
          title: "Result One",
          snippet: "First summary",
          url: "https://example.com/one"
        },
        {
          title: "Result Two",
          snippet: "Second highlight",
          url: "https://example.com/two"
        }
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = previous;
      }
    }
  });

  it("fails search when EXA_API_KEY is missing", async () => {
    const previous = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;

    try {
      const webTool = getWebTool(async () => {
        throw new Error("fetch should not be called when EXA_API_KEY is missing");
      });

      await expect(
        webTool.execute(
          {
            action: "search",
            query: "drost",
            limit: 1
          },
          toolContext
        )
      ).rejects.toThrow("EXA_API_KEY");
    } finally {
      if (previous === undefined) {
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = previous;
      }
    }
  });
});

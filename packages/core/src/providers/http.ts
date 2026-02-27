export interface JsonHttpResponse {
  status: number;
  text: string;
  json: unknown;
}

export interface SseEvent {
  event: string;
  data: string;
}

export interface StreamHttpResponse extends JsonHttpResponse {
  contentType: string | null;
  streamed: boolean;
}

function parseJson(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createTimeoutAbortController(params: {
  timeoutMs: number;
  signal?: AbortSignal;
}): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  const onAbort = (): void => {
    controller.abort();
  };
  params.signal?.addEventListener("abort", onAbort);

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
    }
  };
}

async function parseSseStream(params: {
  stream: ReadableStream<Uint8Array>;
  onEvent: (event: SseEvent) => Promise<void> | void;
}): Promise<void> {
  const reader = params.stream.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const flushEvent = async (): Promise<void> => {
    if (eventName.length === 0 && dataLines.length === 0) {
      return;
    }
    const event: SseEvent = {
      event: eventName || "message",
      data: dataLines.join("\n")
    };
    eventName = "";
    dataLines = [];
    await params.onEvent(event);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let lineBreakIndex = buffer.indexOf("\n");
      while (lineBreakIndex >= 0) {
        const rawLine = buffer.slice(0, lineBreakIndex);
        buffer = buffer.slice(lineBreakIndex + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line.length === 0) {
          await flushEvent();
          lineBreakIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith(":")) {
          lineBreakIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
          lineBreakIndex = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("data:")) {
          const data = line.slice("data:".length);
          dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
          lineBreakIndex = buffer.indexOf("\n");
          continue;
        }

        lineBreakIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        const data = line.slice("data:".length);
        dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
      }
    }
    await flushEvent();
  } finally {
    reader.releaseLock();
  }
}

export async function postJsonWithTimeout(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<JsonHttpResponse> {
  const timeout = createTimeoutAbortController({
    timeoutMs: params.timeoutMs,
    signal: params.signal
  });

  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...params.headers
      },
      body: JSON.stringify(params.body),
      signal: timeout.controller.signal
    });

    const text = await response.text();
    return {
      status: response.status,
      text,
      json: parseJson(text)
    };
  } finally {
    timeout.cleanup();
  }
}

export async function postJsonStreamWithTimeout(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  onSseEvent: (event: SseEvent) => Promise<void> | void;
}): Promise<StreamHttpResponse> {
  const timeout = createTimeoutAbortController({
    timeoutMs: params.timeoutMs,
    signal: params.signal
  });

  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
        ...params.headers
      },
      body: JSON.stringify(params.body),
      signal: timeout.controller.signal
    });

    const contentType = response.headers.get("content-type");
    const isSse = (contentType ?? "").toLowerCase().includes("text/event-stream");

    if (isSse && response.body) {
      await parseSseStream({
        stream: response.body,
        onEvent: params.onSseEvent
      });
      return {
        status: response.status,
        text: "",
        json: null,
        contentType,
        streamed: true
      };
    }

    const text = await response.text();
    return {
      status: response.status,
      text,
      json: parseJson(text),
      contentType,
      streamed: false
    };
  } finally {
    timeout.cleanup();
  }
}

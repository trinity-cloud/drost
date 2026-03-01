export interface TuiGatewaySnapshot {
  state: string;
  startedAt?: string;
  degradedReasons?: string[];
  restartCount?: number;
  healthUrl?: string;
  controlUrl?: string;
}

export interface TuiStreamEvent {
  type: string;
  sessionId: string;
  providerId: string;
  payload: {
    text?: string;
    error?: string;
    toolName?: string;
    metadata?: Record<string, unknown>;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
}

export interface TuiSessionSummary {
  sessionId: string;
  activeProviderId: string;
  pendingProviderId?: string;
  turnInProgress: boolean;
  historyCount: number;
  active?: boolean;
}

export type TuiTranscriptRole = "user" | "assistant" | "system" | "error";

export interface TuiTranscriptEntry {
  id: string;
  role: TuiTranscriptRole;
  sessionId: string;
  providerId?: string;
  text: string;
  usage?: string;
  streaming?: boolean;
}

export interface TuiDashboardSnapshot {
  gateway: TuiGatewaySnapshot;
  toolSummary?: string;
  toolWarnings?: string[];
  providerDiagnostics?: string[];
  sessions?: TuiSessionSummary[];
  transcript?: TuiTranscriptEntry[];
  events?: string[];
}

function line(text: string): string {
  return `[drost] ${text}`;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m"
};

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function colorize(text: string, code: string): string {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${code}${text}${ANSI.reset}`;
}

function padVisible(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const truncated = truncateVisible(text, width);
  const padding = width - visibleLength(truncated);
  if (padding <= 0) {
    return truncated;
  }
  return `${truncated}${" ".repeat(padding)}`;
}

function truncateVisible(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const plain = stripAnsi(text);
  if (plain.length <= width) {
    return text;
  }
  if (width <= 3) {
    return plain.slice(0, width);
  }
  return `${plain.slice(0, width - 3)}...`;
}

function wrapText(text: string, width: number): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [""];
  }
  if (width <= 6) {
    return [truncateVisible(normalized, Math.max(1, width))];
  }
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (word.length <= width) {
      current = word;
      continue;
    }
    let cursor = 0;
    while (cursor < word.length) {
      lines.push(word.slice(cursor, cursor + width));
      cursor += width;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

function trimDrostPrefix(value: string): string {
  return value.startsWith("[drost] ") ? value.slice("[drost] ".length) : value;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, "$1");
}

export function renderMarkdownToTerminal(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) {
    return "";
  }

  const output: string[] = [];
  const lines = normalized.split("\n");
  let inFence = false;

  for (const rawLine of lines) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      if (!inFence && output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }

    if (inFence) {
      output.push(rawLine ? `    ${rawLine}` : "");
      continue;
    }

    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (headingMatch) {
      output.push(stripInlineMarkdown(headingMatch[1] ?? "").toUpperCase());
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(rawLine)) {
      output.push("----");
      continue;
    }

    const quoteMatch = rawLine.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      output.push(`| ${stripInlineMarkdown(quoteMatch[1] ?? "")}`);
      continue;
    }

    const unorderedListMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unorderedListMatch) {
      const indentLevel = Math.min(3, Math.floor((unorderedListMatch[1] ?? "").length / 2));
      output.push(`${"  ".repeat(indentLevel)}- ${stripInlineMarkdown(unorderedListMatch[2] ?? "")}`);
      continue;
    }

    const orderedListMatch = rawLine.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (orderedListMatch) {
      const indentLevel = Math.min(3, Math.floor((orderedListMatch[1] ?? "").length / 2));
      output.push(
        `${"  ".repeat(indentLevel)}${orderedListMatch[2]}. ${stripInlineMarkdown(orderedListMatch[3] ?? "")}`
      );
      continue;
    }

    output.push(stripInlineMarkdown(rawLine));
  }

  const collapsed: string[] = [];
  for (const lineText of output) {
    if (lineText.trim().length === 0) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] === "") {
        continue;
      }
      collapsed.push("");
      continue;
    }
    collapsed.push(lineText);
  }

  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") {
    collapsed.pop();
  }

  return collapsed.join("\n");
}

export function renderGatewayBoot(snapshot: TuiGatewaySnapshot): string[] {
  const lines = [line("========================================")];
  lines.push(
    line(
      `gateway: ${snapshot.state} | restarts=${snapshot.restartCount ?? 0}${snapshot.healthUrl ? ` | health=${snapshot.healthUrl}` : ""}${snapshot.controlUrl ? ` | control=${snapshot.controlUrl}` : ""}`
    )
  );
  if (snapshot.startedAt) {
    lines.push(line(`started: ${snapshot.startedAt}`));
  }
  if (snapshot.degradedReasons && snapshot.degradedReasons.length > 0) {
    for (const reason of snapshot.degradedReasons) {
      lines.push(line(`degraded: ${reason}`));
    }
  }
  lines.push(line("========================================"));
  return lines;
}

export function renderSessionSummary(sessions: TuiSessionSummary[]): string[] {
  if (sessions.length === 0) {
    return [line("sessions: (none)")];
  }
  const lines = [line("sessions:")];
  for (const session of sessions) {
    const marker = session.active ? "*" : " ";
    lines.push(
      line(
        `${marker} ${session.sessionId} provider=${session.activeProviderId} pending=${session.pendingProviderId ?? "(none)"} messages=${session.historyCount}${session.turnInProgress ? " [busy]" : ""}`
      )
    );
  }
  return lines;
}

export function renderCommandHints(): string {
  return line(
    "commands: /providers /provider <id> /session <id> /sessions /new /status /tools /tool <name> [json] /help /restart"
  );
}

function roleLabel(entry: TuiTranscriptEntry): string {
  if (entry.role === "user") {
    return colorize("you", `${ANSI.bold}${ANSI.green}`);
  }
  if (entry.role === "assistant") {
    return colorize(entry.providerId ?? "assistant", `${ANSI.bold}${ANSI.cyan}`);
  }
  if (entry.role === "error") {
    return colorize("error", `${ANSI.bold}${ANSI.red}`);
  }
  return colorize("system", `${ANSI.bold}${ANSI.yellow}`);
}

function renderTranscriptEntry(entry: TuiTranscriptEntry, width: number): string[] {
  const bodyWidth = Math.max(12, width - 2);
  const renderedMarkdown = renderMarkdownToTerminal(entry.text || "(waiting for response)");
  const wrapped = renderedMarkdown
    .split("\n")
    .flatMap((lineText) => (lineText.trim().length === 0 ? [""] : wrapText(lineText, bodyWidth)));
  const prefix = `${roleLabel(entry)} [${entry.sessionId}]${entry.streaming ? " ..." : ""}`;
  const lines: string[] = [];
  const first = wrapped[0] ?? "";
  lines.push(`${prefix}: ${first}`);
  for (const continuation of wrapped.slice(1)) {
    lines.push(`  ${continuation}`);
  }
  if (entry.usage) {
    lines.push(colorize(`  usage ${entry.usage}`, ANSI.dim));
  }
  return lines;
}

function renderTranscriptPanel(snapshot: TuiDashboardSnapshot, width: number, rows: number): string[] {
  const header = [
    colorize("CHAT", `${ANSI.bold}${ANSI.cyan}`),
    colorize("-".repeat(Math.max(8, width)), ANSI.dim)
  ];
  const content: string[] = [];
  const transcript = snapshot.transcript ?? [];
  if (transcript.length === 0) {
    content.push(colorize("No conversation yet. Send a prompt to start.", ANSI.dim));
  } else {
    const rendered = transcript.flatMap((entry) => renderTranscriptEntry(entry, width));
    const available = Math.max(1, rows - header.length);
    const recent = rendered.slice(-available);
    content.push(...recent);
  }
  const lines = [...header, ...content];
  while (lines.length < rows) {
    lines.push("");
  }
  return lines;
}

function renderMetaPanel(
  snapshot: TuiDashboardSnapshot,
  width: number,
  rows: number,
  maxEvents: number
): string[] {
  const lines: string[] = [];
  const sessions = snapshot.sessions ?? [];
  lines.push(colorize("SYSTEM", `${ANSI.bold}${ANSI.yellow}`));
  lines.push(colorize("-".repeat(Math.max(8, width)), ANSI.dim));

  const stateColor =
    snapshot.gateway.state === "healthy"
      ? `${ANSI.bold}${ANSI.green}`
      : snapshot.gateway.state === "degraded"
        ? `${ANSI.bold}${ANSI.yellow}`
        : `${ANSI.bold}${ANSI.red}`;
  lines.push(`state: ${colorize(snapshot.gateway.state, stateColor)}`);
  lines.push(`restarts: ${snapshot.gateway.restartCount ?? 0}`);
  if (snapshot.gateway.startedAt) {
    lines.push(`started: ${snapshot.gateway.startedAt}`);
  }
  if (snapshot.gateway.healthUrl) {
    lines.push(`health: ${snapshot.gateway.healthUrl}`);
  }

  for (const reason of (snapshot.gateway.degradedReasons ?? []).slice(0, 2)) {
    lines.push(colorize(`degraded: ${reason}`, ANSI.yellow));
  }

  if (snapshot.toolSummary) {
    lines.push(`tools: ${snapshot.toolSummary}`);
  }
  if ((snapshot.providerDiagnostics ?? []).length > 0) {
    lines.push(`probes: ${(snapshot.providerDiagnostics ?? []).length}`);
  }

  lines.push("");
  lines.push(colorize("SESSIONS", `${ANSI.bold}${ANSI.yellow}`));
  if (sessions.length === 0) {
    lines.push(colorize("none", ANSI.dim));
  } else {
    for (const session of sessions.slice(0, 6)) {
      const marker = session.active ? "*" : " ";
      lines.push(
        `${marker} ${session.sessionId} ${session.activeProviderId}${session.pendingProviderId ? ` -> ${session.pendingProviderId}` : ""}${session.turnInProgress ? " [busy]" : ""}`
      );
    }
  }

  lines.push("");
  lines.push(colorize("EVENTS", `${ANSI.bold}${ANSI.yellow}`));
  const remaining = Math.max(1, rows - lines.length);
  const visibleEvents = (snapshot.events ?? []).slice(-Math.min(maxEvents, remaining));
  if (visibleEvents.length === 0) {
    lines.push(colorize("none", ANSI.dim));
  } else {
    for (const eventLine of visibleEvents) {
      lines.push(eventLine);
    }
  }

  if (lines.length > rows) {
    return lines.slice(0, rows);
  }
  while (lines.length < rows) {
    lines.push("");
  }
  return lines;
}

export function renderDashboard(
  snapshot: TuiDashboardSnapshot,
  options?: {
    maxEvents?: number;
    width?: number;
    height?: number;
  }
): string[] {
  const width = Math.max(80, options?.width ?? process.stdout.columns ?? 110);
  const height = Math.max(18, options?.height ?? process.stdout.rows ?? 30);
  const maxEvents = options?.maxEvents ?? 12;

  const separator = "-".repeat(width);
  const title = colorize("DROST", `${ANSI.bold}${ANSI.cyan}`);
  const stateColor =
    snapshot.gateway.state === "healthy"
      ? `${ANSI.bold}${ANSI.green}`
      : snapshot.gateway.state === "degraded"
        ? `${ANSI.bold}${ANSI.yellow}`
        : `${ANSI.bold}${ANSI.red}`;
  const subtitle = `gateway=${colorize(snapshot.gateway.state, stateColor)} restarts=${snapshot.gateway.restartCount ?? 0}`;
  const bodyRows = Math.max(8, height - 5);

  let leftWidth = Math.floor((width - 3) * 0.64);
  let rightWidth = width - leftWidth - 3;
  if (leftWidth < 42) {
    leftWidth = 42;
    rightWidth = width - leftWidth - 3;
  }
  if (rightWidth < 30) {
    rightWidth = 30;
    leftWidth = Math.max(40, width - rightWidth - 3);
  }

  const left = renderTranscriptPanel(snapshot, leftWidth, bodyRows);
  const right = renderMetaPanel(snapshot, rightWidth, bodyRows, maxEvents);

  const lines: string[] = [];
  lines.push(padVisible(`${title}  ${subtitle}`, width));
  lines.push(separator);
  for (let index = 0; index < bodyRows; index += 1) {
    const leftLine = padVisible(left[index] ?? "", leftWidth);
    const rightLine = padVisible(right[index] ?? "", rightWidth);
    lines.push(`${leftLine} | ${rightLine}`);
  }
  lines.push(separator);
  lines.push(
    padVisible(
      colorize(trimDrostPrefix(renderCommandHints()), ANSI.dim),
      width
    )
  );
  return lines;
}

export function renderStreamEvent(event: TuiStreamEvent): string {
  if (event.type === "response.delta") {
    return line(`[${event.sessionId}] ${event.providerId}: ${event.payload.text ?? ""}`);
  }
  if (event.type === "tool.call.started") {
    return line(
      `[${event.sessionId}] tool ${event.payload.toolName ?? "unknown"}: started`
    );
  }
  if (event.type === "tool.call.completed") {
    const metadata = event.payload.metadata;
    const ok =
      metadata && typeof metadata === "object" && typeof (metadata as { ok?: unknown }).ok === "boolean"
        ? Boolean((metadata as { ok?: unknown }).ok)
        : event.payload.error === undefined;
    return line(
      `[${event.sessionId}] tool ${event.payload.toolName ?? "unknown"}: ${ok ? "completed" : `failed (${event.payload.error ?? "error"})`}`
    );
  }
  if (event.type === "usage.updated") {
    const usage = event.payload.usage;
    return line(
      `[${event.sessionId}] usage: in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"} total=${usage?.totalTokens ?? "?"}`
    );
  }
  if (event.type === "response.completed") {
    return line(`[${event.sessionId}] ${event.providerId}: response.completed`);
  }
  if (event.type === "provider.error") {
    return line(`[${event.sessionId}] ${event.providerId} error: ${event.payload.error ?? "unknown"}`);
  }
  return line(`[${event.sessionId}] ${event.type}`);
}

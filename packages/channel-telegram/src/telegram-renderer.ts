import fs from "node:fs";

export interface TelegramRenderResult {
  text: string;
  parseMode?: "HTML";
}

interface MarkdownRenderState {
  inCodeFence: boolean;
  codeFenceLines: string[];
  paragraphLines: string[];
  output: string[];
}

const MAX_BLANK_LINE_RUN = 1;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeSimpleMarkdown(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()#+\-.!>~])/g, "$1");
}

function collapseBlankRuns(lines: string[]): string[] {
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      blankRun += 1;
      if (blankRun > MAX_BLANK_LINE_RUN) {
        continue;
      }
      collapsed.push("");
      continue;
    }
    blankRun = 0;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") {
    collapsed.pop();
  }
  return collapsed;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function stripToolProtocolLines(value: string): string {
  const lines = normalizeNewlines(value).split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (
      upper.startsWith("TOOL_CALL") ||
      upper.startsWith("TOOL_RESULT") ||
      upper.startsWith("TOOL_")
    ) {
      continue;
    }
    kept.push(line);
  }
  return collapseBlankRuns(kept).join("\n").trim();
}

export function stripInlineMarkdown(value: string): string {
  let next = unescapeSimpleMarkdown(value);
  next = next.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, url: string) => {
    const label = alt.trim() || "image";
    return `${label} (${url})`;
  });
  next = next.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    return `${label} (${url})`;
  });
  next = next.replace(/`([^`\n]+)`/g, (_, code: string) => {
    return `'${code}'`;
  });

  const patterns: RegExp[] = [
    /\*\*([^*\n]+)\*\*/g,
    /__([^_\n]+)__/g,
    /~~([^~\n]+)~~/g,
    /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
    /(?<!_)_([^_\n]+)_(?!_)/g
  ];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = next;
    for (const pattern of patterns) {
      next = next.replace(pattern, "$1");
    }
    if (next === before) {
      break;
    }
  }
  return next;
}

export function renderInlineHtml(value: string): string {
  const placeholders = new Map<string, string>();
  let placeholderId = 0;

  const stash = (rendered: string): string => {
    const token = `@@TGRENDER${placeholderId}@@`;
    placeholderId += 1;
    placeholders.set(token, rendered);
    return token;
  };

  let next = unescapeSimpleMarkdown(value);
  next = next.replace(/`([^`\n]+)`/g, (_all: string, code: string) => {
    return stash(`<code>${escapeHtml(code)}</code>`);
  });

  next = next.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_all: string, label: string, url: string) => {
      let href = url;
      if (!/^[a-zA-Z]+:\/\//.test(href) && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        href = 'https://' + href;
      }
      return stash(`<a href="${escapeHtmlAttribute(href)}">${escapeHtml(label)}</a>`);
    }
  );

  next = escapeHtml(next);

  const formattingPatterns: Array<{ pattern: RegExp; open: string; close: string }> = [
    {
      pattern: /\*\*([^*\n][^*\n]*?)\*\*/g,
      open: "<b>",
      close: "</b>"
    },
    {
      pattern: /__([^_\n][^_\n]*?)__/g,
      open: "<b>",
      close: "</b>"
    },
    {
      pattern: /~~([^~\n][^~\n]*?)~~/g,
      open: "<s>",
      close: "</s>"
    },
    {
      pattern: /(?<!\*)\*([^*\n][^*\n]*?)\*(?!\*)/g,
      open: "<i>",
      close: "</i>"
    },
    {
      pattern: /(?<!_)_([^_\n][^_\n]*?)_(?!_)/g,
      open: "<i>",
      close: "</i>"
    }
  ];

  for (let pass = 0; pass < 4; pass += 1) {
    const before = next;
    for (const item of formattingPatterns) {
      next = next.replace(item.pattern, (_all: string, content: string) => {
        return `${item.open}${content}${item.close}`;
      });
    }
    if (next === before) {
      break;
    }
  }

  for (const [token, rendered] of placeholders.entries()) {
    next = next.split(token).join(rendered);
  }
  return next;
}

function isTableBlock(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const hasPipe = lines.some(l => l.includes('|'));
  if (!hasPipe) return false;
  const hasDivider = lines.some(l => /^[|\s:-]+$/.test(l) && l.includes('-') && l.includes('|'));
  return hasDivider;
}

function formatTableHtml(lines: string[]): string {
  const rows = lines.map(line => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(c => c.trim());
  });
  
  const numCols = Math.max(...rows.map(r => r.length));
  
  const colWidths = new Array<number>(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? '';
      const visibleLength = stripInlineMarkdown(cell).length;
      if (visibleLength > (colWidths[i] ?? 0)) {
        colWidths[i] = visibleLength;
      }
    }
  }
  
  const formattedLines = rows.map((row, rIdx) => {
    const isDivider = lines[rIdx]?.replace(/[|\s:-]/g, '') === '';
    
    let out = '|';
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] ?? '';
      if (isDivider) {
        out += '-'.repeat((colWidths[i] ?? 0) + 2) + '|';
      } else {
        const visibleLength = stripInlineMarkdown(cell).length;
        const padding = Math.max(0, (colWidths[i] ?? 0) - visibleLength);
        out += ' ' + renderInlineHtml(cell) + ' '.repeat(padding) + ' |';
      }
    }
    return out;
  });
  
  return `<pre><code>${formattedLines.join('\n')}</code></pre>`;
}

function formatTablePreview(lines: string[]): string {
  const rows = lines.map(line => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(c => c.trim());
  });
  
  const numCols = Math.max(...rows.map(r => r.length));
  
  const colWidths = new Array<number>(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? '';
      const visibleLength = stripInlineMarkdown(cell).length;
      if (visibleLength > (colWidths[i] ?? 0)) {
        colWidths[i] = visibleLength;
      }
    }
  }
  
  const formattedLines = rows.map((row, rIdx) => {
    const isDivider = lines[rIdx]?.replace(/[|\s:-]/g, '') === '';
    
    let out = '|';
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] ?? '';
      if (isDivider) {
        out += '-'.repeat((colWidths[i] ?? 0) + 2) + '|';
      } else {
        const visibleLength = stripInlineMarkdown(cell).length;
        const padding = Math.max(0, (colWidths[i] ?? 0) - visibleLength);
        out += ' ' + stripInlineMarkdown(cell) + ' '.repeat(padding) + ' |';
      }
    }
    return out;
  });
  
  return formattedLines.join('\n');
}

function processHtmlParagraphLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.includes('|')) {
      let j = i;
      while (j < lines.length && lines[j]?.includes('|')) {
        j++;
      }
      const potentialTable = lines.slice(i, j);
      if (isTableBlock(potentialTable)) {
        out.push(formatTableHtml(potentialTable));
        i = j;
        continue;
      }
    }
    
    let textLines: string[] = [];
    while (i < lines.length && !lines[i]?.includes('|')) {
      if (lines[i] !== undefined) {
        textLines.push(lines[i] as string);
      }
      i++;
    }
    if (textLines.length > 0) {
      out.push(textLines.map(l => renderInlineHtml(l).trimEnd()).join('\n'));
    } else if (i < lines.length) {
      out.push(renderInlineHtml(lines[i] as string).trimEnd());
      i++;
    }
  }
  return out;
}

function processPreviewParagraphLines(lines: string[]): string[] {
  if (lines.length === 0) return [];
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.includes('|')) {
      let j = i;
      while (j < lines.length && lines[j]?.includes('|')) {
        j++;
      }
      const potentialTable = lines.slice(i, j);
      if (isTableBlock(potentialTable)) {
        out.push(formatTablePreview(potentialTable));
        i = j;
        continue;
      }
    }
    
    let textLines: string[] = [];
    while (i < lines.length && !lines[i]?.includes('|')) {
      if (lines[i] !== undefined) {
        textLines.push(lines[i] as string);
      }
      i++;
    }
    if (textLines.length > 0) {
      out.push(textLines.map(l => stripInlineMarkdown(l).trimEnd()).join('\n'));
    } else if (i < lines.length) {
      out.push(stripInlineMarkdown(lines[i] as string).trimEnd());
      i++;
    }
  }
  return out;
}

function finalizePreviewParagraph(state: MarkdownRenderState): void {
  if (state.paragraphLines.length === 0) {
    return;
  }
  const blocks = processPreviewParagraphLines(state.paragraphLines);
  for (const block of blocks) {
    state.output.push(block);
  }
  state.paragraphLines = [];
}

function finalizeHtmlParagraph(state: MarkdownRenderState): void {
  if (state.paragraphLines.length === 0) {
    return;
  }
  const blocks = processHtmlParagraphLines(state.paragraphLines);
  for (const block of blocks) {
    state.output.push(block);
  }
  state.paragraphLines = [];
}

function finalizePreviewCodeFence(state: MarkdownRenderState): void {
  if (state.codeFenceLines.length === 0) {
    state.output.push("```");
    return;
  }
  state.output.push("```");
  for (const line of state.codeFenceLines) {
    state.output.push(line);
  }
  state.output.push("```");
  state.codeFenceLines = [];
}

function finalizeHtmlCodeFence(state: MarkdownRenderState): void {
  const body = state.codeFenceLines.join("\n");
  state.output.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
  state.codeFenceLines = [];
}

function renderPreviewLines(value: string): string[] {
  const lines = normalizeNewlines(value).split("\n");
  const state: MarkdownRenderState = {
    inCodeFence: false,
    codeFenceLines: [],
    paragraphLines: [],
    output: []
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (state.inCodeFence) {
        finalizePreviewCodeFence(state);
        state.inCodeFence = false;
      } else {
        finalizePreviewParagraph(state);
        state.inCodeFence = true;
      }
      continue;
    }

    if (state.inCodeFence) {
      state.codeFenceLines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      finalizePreviewParagraph(state);
      state.output.push("");
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      finalizePreviewParagraph(state);
      state.output.push(stripInlineMarkdown(heading[1] ?? "").toUpperCase());
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      finalizePreviewParagraph(state);
      state.output.push("----");
      continue;
    }

    const quote = line.match(/^\s*(>+)\s?(.*)$/);
    if (quote) {
      finalizePreviewParagraph(state);
      const level = Math.max(1, (quote[1] ?? "").length);
      state.output.push(`${"  ".repeat(level - 1)}| ${stripInlineMarkdown(quote[2] ?? "")}`);
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unordered) {
      finalizePreviewParagraph(state);
      const indent = Math.min(3, Math.floor((unordered[1] ?? "").length / 2));
      state.output.push(`${"  ".repeat(indent)}- ${stripInlineMarkdown(unordered[2] ?? "")}`);
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      finalizePreviewParagraph(state);
      const indent = Math.min(3, Math.floor((ordered[1] ?? "").length / 2));
      state.output.push(`${"  ".repeat(indent)}${ordered[2]}. ${stripInlineMarkdown(ordered[3] ?? "")}`);
      continue;
    }

    state.paragraphLines.push(line);
  }

  if (state.inCodeFence) {
    finalizePreviewCodeFence(state);
  }
  finalizePreviewParagraph(state);

  return collapseBlankRuns(state.output);
}

function renderHtmlLines(value: string): string[] {
  const lines = normalizeNewlines(value).split("\n");
  const state: MarkdownRenderState = {
    inCodeFence: false,
    codeFenceLines: [],
    paragraphLines: [],
    output: []
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (state.inCodeFence) {
        finalizeHtmlCodeFence(state);
        state.inCodeFence = false;
      } else {
        finalizeHtmlParagraph(state);
        state.inCodeFence = true;
      }
      continue;
    }

    if (state.inCodeFence) {
      state.codeFenceLines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      finalizeHtmlParagraph(state);
      state.output.push("");
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      finalizeHtmlParagraph(state);
      state.output.push(`<b>${renderInlineHtml(heading[1] ?? "")}</b>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      finalizeHtmlParagraph(state);
      state.output.push("----");
      continue;
    }

    const quote = line.match(/^\s*(>+)\s?(.*)$/);
    if (quote) {
      finalizeHtmlParagraph(state);
      const level = Math.max(1, (quote[1] ?? "").length);
      state.output.push(`${"  ".repeat(level - 1)}| ${renderInlineHtml(quote[2] ?? "")}`);
      continue;
    }

    const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unordered) {
      finalizeHtmlParagraph(state);
      const indent = Math.min(3, Math.floor((unordered[1] ?? "").length / 2));
      state.output.push(`${"  ".repeat(indent)}- ${renderInlineHtml(unordered[2] ?? "")}`);
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      finalizeHtmlParagraph(state);
      const indent = Math.min(3, Math.floor((ordered[1] ?? "").length / 2));
      state.output.push(`${"  ".repeat(indent)}${ordered[2]}. ${renderInlineHtml(ordered[3] ?? "")}`);
      continue;
    }

    state.paragraphLines.push(line);
  }

  if (state.inCodeFence) {
    finalizeHtmlCodeFence(state);
  }
  finalizeHtmlParagraph(state);

  return collapseBlankRuns(state.output);
}

export function renderTelegramStreamingPreview(value: string): string {
  const visible = stripToolProtocolLines(value);
  if (!visible) {
    return "";
  }
  return renderPreviewLines(visible).join("\n").trim();
}

export function renderTelegramFinalMessage(
  value: string,
  options?: {
    maxHtmlChars?: number;
  }
): TelegramRenderResult[] {
  const visible = stripToolProtocolLines(value);
  if (!visible) {
    return [];
  }

  const htmlBlocks = renderHtmlLines(visible);
  const maxHtmlChars = options?.maxHtmlChars ?? 4000;
  
  const results: TelegramRenderResult[] = [];
  let currentChunk = "";

  for (const block of htmlBlocks) {
    if (!currentChunk) {
      currentChunk = block;
    } else if (currentChunk.length + 1 + block.length <= maxHtmlChars) {
      currentChunk += "\n" + block;
    } else {
      results.push({ text: currentChunk, parseMode: "HTML" });
      currentChunk = block;
    }
  }
  
  if (currentChunk) {
    results.push({ text: currentChunk, parseMode: "HTML" });
  }

  return results;
}

export function stripTelegramHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

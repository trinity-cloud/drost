import fs from "node:fs";
import path from "node:path";
import type { GatewaySkillsConfig, SkillInjectionMode } from "../config.js";
import type {
  SkillBlockedRecord,
  SkillInjectionPlan,
  SkillRecord,
  SkillRuntimeStatus,
  SkillSelection
} from "./types.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_INJECTED = 3;
const MAX_SKILL_TEXT_CHARS = 3_500;

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_\-]+/g, "").trim();
}

function tokenize(value: string): string[] {
  const tokens = value
    .split(/[^a-zA-Z0-9_\-]+/)
    .map((token) => normalizeToken(token))
    .filter((token) => token.length >= 3);
  return Array.from(new Set(tokens));
}

function summarizeSkillContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_SKILL_TEXT_CHARS) {
    return trimmed;
  }
  const dropped = trimmed.length - MAX_SKILL_TEXT_CHARS;
  return `${trimmed.slice(0, MAX_SKILL_TEXT_CHARS)}\n\n...[truncated ${dropped} chars]`;
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) {
      continue;
    }
    const title = trimmed.replace(/^#+\s*/, "").trim();
    if (title.length > 0) {
      return title;
    }
  }
  return null;
}

function resolveRootPath(workspaceDir: string, root: string): string {
  return path.isAbsolute(root) ? path.resolve(root) : path.resolve(workspaceDir, root);
}

function collectSkillFiles(root: string, maxDepth = 6): string[] {
  const files: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        files.push(absolute);
      }
    }
  };
  walk(root, 0);
  return files;
}

function parseManifest(skillDirectory: string): Record<string, unknown> {
  const manifestNames = ["skill.json", "manifest.json"];
  for (const name of manifestNames) {
    const manifestPath = path.join(skillDirectory, name);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const parsed = readJsonFile(manifestPath);
    if (parsed) {
      return parsed;
    }
  }
  return {};
}

function modeFromConfig(value: SkillInjectionMode | undefined): SkillInjectionMode {
  if (value === "all" || value === "relevant") {
    return value;
  }
  return "off";
}

function buildSkillRecord(skillFilePath: string): SkillRecord | null {
  let content = "";
  try {
    content = fs.readFileSync(skillFilePath, "utf8");
  } catch {
    return null;
  }
  const skillDirectory = path.dirname(skillFilePath);
  const manifest = parseManifest(skillDirectory);
  const rawId =
    typeof manifest.id === "string" && manifest.id.trim().length > 0
      ? manifest.id.trim()
      : path.basename(skillDirectory);
  const id = normalizeToken(rawId);
  if (!id) {
    return null;
  }
  const heading = firstHeading(content);
  const name =
    typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : heading ?? rawId;
  const description =
    typeof manifest.description === "string" && manifest.description.trim().length > 0
      ? manifest.description.trim()
      : undefined;

  const manifestKeywords =
    Array.isArray(manifest.keywords) || Array.isArray(manifest.tags)
      ? [
          ...((Array.isArray(manifest.keywords) ? manifest.keywords : []) as unknown[]),
          ...((Array.isArray(manifest.tags) ? manifest.tags : []) as unknown[])
        ]
          .map((entry) => (typeof entry === "string" ? normalizeToken(entry) : ""))
          .filter((entry) => entry.length > 0)
      : [];

  const keywords = Array.from(
    new Set([
      ...tokenize(id),
      ...tokenize(name),
      ...tokenize(description ?? ""),
      ...manifestKeywords,
      ...tokenize(content.slice(0, 3_000))
    ])
  );

  return {
    id,
    name,
    description,
    root: skillDirectory,
    skillFilePath,
    content: summarizeSkillContent(content),
    keywords
  };
}

function skillScore(skill: SkillRecord, inputTokens: Set<string>): number {
  if (inputTokens.size === 0) {
    return 0;
  }
  let score = 0;
  for (const keyword of skill.keywords) {
    if (inputTokens.has(keyword)) {
      score += 1;
    }
  }
  return score;
}

export class SkillRuntime {
  private readonly workspaceDir: string;
  private readonly config: GatewaySkillsConfig | undefined;
  private roots: string[] = [];
  private readonly blocked: SkillBlockedRecord[] = [];
  private readonly discovered: SkillRecord[] = [];
  private readonly allowed: SkillRecord[] = [];

  constructor(params: {
    workspaceDir: string;
    config?: GatewaySkillsConfig;
  }) {
    this.workspaceDir = path.resolve(params.workspaceDir);
    this.config = params.config;
  }

  private configuredRoots(): string[] {
    const roots = this.config?.roots ?? [];
    return Array.from(
      new Set(
        roots
          .map((root) => root.trim())
          .filter((root) => root.length > 0)
          .map((root) => resolveRootPath(this.workspaceDir, root))
      )
    );
  }

  private allowSet(): Set<string> {
    return new Set(
      (this.config?.allow ?? [])
        .map((entry) => normalizeToken(entry))
        .filter((entry) => entry.length > 0)
    );
  }

  private denySet(): Set<string> {
    return new Set(
      (this.config?.deny ?? [])
        .map((entry) => normalizeToken(entry))
        .filter((entry) => entry.length > 0)
    );
  }

  refresh(): void {
    this.roots = this.configuredRoots();
    this.blocked.length = 0;
    this.discovered.length = 0;
    this.allowed.length = 0;

    if (!(this.config?.enabled ?? false)) {
      return;
    }

    const allowSet = this.allowSet();
    const denySet = this.denySet();
    const seen = new Set<string>();

    for (const root of this.roots) {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        this.blocked.push({
          root,
          reason: "missing_root",
          message: "Skill root does not exist or is not a directory"
        });
        continue;
      }

      for (const skillFilePath of collectSkillFiles(root)) {
        const skill = buildSkillRecord(skillFilePath);
        if (!skill) {
          this.blocked.push({
            root,
            skillFilePath,
            reason: "invalid_skill",
            message: "Invalid SKILL.md or manifest shape"
          });
          continue;
        }

        this.discovered.push(skill);
        if (seen.has(skill.id)) {
          this.blocked.push({
            root,
            skillFilePath,
            skillId: skill.id,
            reason: "invalid_skill",
            message: `Duplicate skill id: ${skill.id}`
          });
          continue;
        }

        if (denySet.has(skill.id)) {
          this.blocked.push({
            root,
            skillFilePath,
            skillId: skill.id,
            reason: "deny_blocked",
            message: "Skill is blocked by skills.deny"
          });
          continue;
        }

        if (allowSet.size > 0 && !allowSet.has(skill.id)) {
          this.blocked.push({
            root,
            skillFilePath,
            skillId: skill.id,
            reason: "allow_blocked",
            message: "Skill is not present in skills.allow"
          });
          continue;
        }

        seen.add(skill.id);
        this.allowed.push(skill);
      }
    }

    this.allowed.sort((left, right) => left.id.localeCompare(right.id));
  }

  private selectedMode(mode?: SkillInjectionMode): SkillInjectionMode {
    if (mode === "off" || mode === "all" || mode === "relevant") {
      return mode;
    }
    return modeFromConfig(this.config?.injectionMode);
  }

  private maxInjected(configured?: number): number {
    const raw = configured ?? this.config?.maxInjected ?? DEFAULT_MAX_INJECTED;
    if (!Number.isFinite(raw)) {
      return DEFAULT_MAX_INJECTED;
    }
    return Math.max(1, Math.min(20, Math.floor(raw)));
  }

  private relevantSelection(input: string, maxInjected: number): SkillSelection[] {
    const inputTokens = new Set(tokenize(input));
    if (inputTokens.size === 0) {
      return [];
    }
    const scored = this.allowed
      .map((skill) => ({
        skill,
        score: skillScore(skill, inputTokens)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.skill.id.localeCompare(right.skill.id);
      });
    return scored.slice(0, maxInjected);
  }

  private allSelection(maxInjected: number): SkillSelection[] {
    return this.allowed.slice(0, maxInjected).map((skill) => ({
      skill,
      score: 1
    }));
  }

  private renderInjectionText(selections: SkillSelection[]): string {
    if (selections.length === 0) {
      return "";
    }
    const lines: string[] = [
      "[SKILLS CONTEXT]",
      "Use the following local skills as guidance when relevant."
    ];

    for (const entry of selections) {
      const skill = entry.skill;
      lines.push(`- Skill: ${skill.name} (${skill.id})`);
      if (skill.description) {
        lines.push(`  Description: ${skill.description}`);
      }
      const snippet = skill.content
        .split(/\r?\n/)
        .slice(0, 40)
        .join("\n")
        .trim();
      if (snippet.length > 0) {
        lines.push("  Content:");
        lines.push(snippet);
      }
    }

    return lines.join("\n");
  }

  buildInjectionPlan(params: {
    input: string;
    mode?: SkillInjectionMode;
    maxInjected?: number;
  }): SkillInjectionPlan {
    const mode = this.selectedMode(params.mode);
    const maxInjected = this.maxInjected(params.maxInjected);

    if (!(this.config?.enabled ?? false) || mode === "off") {
      return {
        mode,
        selected: []
      };
    }

    const selected = mode === "all" ? this.allSelection(maxInjected) : this.relevantSelection(params.input, maxInjected);
    if (selected.length === 0) {
      return {
        mode,
        selected
      };
    }

    return {
      mode,
      selected,
      text: this.renderInjectionText(selected)
    };
  }

  listAllowed(): SkillRecord[] {
    return [...this.allowed];
  }

  listBlocked(): SkillBlockedRecord[] {
    return [...this.blocked];
  }

  getStatus(): SkillRuntimeStatus {
    return {
      enabled: this.config?.enabled ?? false,
      roots: [...this.roots],
      discovered: this.discovered.length,
      allowed: this.allowed.length,
      blocked: this.listBlocked(),
      injectionMode: modeFromConfig(this.config?.injectionMode),
      maxInjected: this.maxInjected()
    };
  }
}

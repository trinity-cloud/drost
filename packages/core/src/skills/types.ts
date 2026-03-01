import type { SkillInjectionMode } from "../config.js";

export interface SkillRecord {
  id: string;
  name: string;
  description?: string;
  root: string;
  skillFilePath: string;
  content: string;
  keywords: string[];
}

export type SkillBlockedReason = "missing_root" | "invalid_skill" | "allow_blocked" | "deny_blocked";

export interface SkillBlockedRecord {
  root: string;
  skillFilePath?: string;
  skillId?: string;
  reason: SkillBlockedReason;
  message: string;
}

export interface SkillSelection {
  skill: SkillRecord;
  score: number;
}

export interface SkillInjectionPlan {
  mode: SkillInjectionMode;
  selected: SkillSelection[];
  text?: string;
}

export interface SkillRuntimeStatus {
  enabled: boolean;
  roots: string[];
  discovered: number;
  allowed: number;
  blocked: SkillBlockedRecord[];
  injectionMode: SkillInjectionMode;
  maxInjected: number;
}

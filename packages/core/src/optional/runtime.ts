import fs from "node:fs";
import path from "node:path";
import type {
  GatewayBackupModuleConfig,
  GatewayGraphModuleConfig,
  GatewayMemoryModuleConfig,
  GatewayOptionalModulesConfig,
  GatewaySchedulerModuleConfig
} from "../config.js";

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface OptionalModuleStatus {
  module: "memory" | "graph" | "scheduler" | "backup";
  enabled: boolean;
  healthy: boolean;
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export class OptionalModuleRuntime {
  private readonly workspaceDir: string;
  private readonly config: GatewayOptionalModulesConfig | undefined;
  private readonly statuses = new Map<OptionalModuleStatus["module"], OptionalModuleStatus>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    workspaceDir: string;
    config?: GatewayOptionalModulesConfig;
  }) {
    this.workspaceDir = path.resolve(params.workspaceDir);
    this.config = params.config;
  }

  private setStatus(
    module: OptionalModuleStatus["module"],
    enabled: boolean,
    healthy: boolean,
    message: string,
    details?: Record<string, unknown>
  ): void {
    this.statuses.set(module, {
      module,
      enabled,
      healthy,
      message,
      checkedAt: nowIso(),
      details
    });
  }

  private memoryDirectory(config: GatewayMemoryModuleConfig | undefined): string {
    const directory = config?.directory?.trim() || path.join(".drost", "memory");
    return path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(this.workspaceDir, directory);
  }

  private graphDirectory(config: GatewayGraphModuleConfig | undefined): string {
    const directory = config?.directory?.trim() || path.join(".drost", "graph");
    return path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(this.workspaceDir, directory);
  }

  private schedulerHeartbeatFile(config: GatewaySchedulerModuleConfig | undefined): string {
    const filePath = config?.heartbeatFile?.trim() || path.join(".drost", "automation", "heartbeat.json");
    return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(this.workspaceDir, filePath);
  }

  private backupDirectory(config: GatewayBackupModuleConfig | undefined): string {
    const directory = config?.directory?.trim() || path.join(".drost", "backups");
    return path.isAbsolute(directory) ? path.resolve(directory) : path.resolve(this.workspaceDir, directory);
  }

  private runMemoryPreflight(config: GatewayMemoryModuleConfig | undefined): void {
    const enabled = config?.enabled ?? false;
    if (!enabled) {
      this.setStatus("memory", false, true, "disabled");
      return;
    }

    const provider = config?.provider ?? "filesystem";
    if (provider === "filesystem") {
      const directory = this.memoryDirectory(config);
      ensureDirectory(directory);
      this.setStatus("memory", true, true, "filesystem backend ready", {
        provider,
        directory,
        vectorEnabled: config?.vectorEnabled ?? false
      });
      return;
    }

    if (provider === "postgres") {
      if (!config?.postgresUrl || config.postgresUrl.trim().length === 0) {
        this.setStatus("memory", true, false, "postgresUrl is required for memory provider=postgres", {
          provider
        });
        return;
      }
      this.setStatus("memory", true, true, "postgres configuration accepted", {
        provider,
        vectorEnabled: config?.vectorEnabled ?? false
      });
      return;
    }

    this.setStatus("memory", true, false, `Unsupported memory provider: ${String(provider)}`);
  }

  private runGraphPreflight(config: GatewayGraphModuleConfig | undefined): void {
    const enabled = config?.enabled ?? false;
    if (!enabled) {
      this.setStatus("graph", false, true, "disabled");
      return;
    }

    const provider = config?.provider ?? "filesystem";
    if (provider === "filesystem") {
      const directory = this.graphDirectory(config);
      ensureDirectory(directory);
      this.setStatus("graph", true, true, "filesystem backend ready", {
        provider,
        directory
      });
      return;
    }

    if (provider === "neo4j") {
      if (!config?.neo4jUrl || config.neo4jUrl.trim().length === 0) {
        this.setStatus("graph", true, false, "neo4jUrl is required for graph provider=neo4j", {
          provider
        });
        return;
      }
      this.setStatus("graph", true, true, "neo4j configuration accepted", {
        provider
      });
      return;
    }

    this.setStatus("graph", true, false, `Unsupported graph provider: ${String(provider)}`);
  }

  private runSchedulerPreflight(config: GatewaySchedulerModuleConfig | undefined): void {
    const enabled = config?.enabled ?? false;
    if (!enabled) {
      this.setStatus("scheduler", false, true, "disabled");
      return;
    }

    const intervalMs = Math.max(1_000, Math.floor(config?.heartbeatIntervalMs ?? 10_000));
    const heartbeatFile = this.schedulerHeartbeatFile(config);
    ensureDirectory(path.dirname(heartbeatFile));

    const writeHeartbeat = (): void => {
      const payload = {
        timestamp: nowIso(),
        intervalMs
      };
      fs.writeFileSync(heartbeatFile, JSON.stringify(payload, null, 2), "utf8");
    };

    writeHeartbeat();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatTimer = setInterval(writeHeartbeat, intervalMs);
    this.setStatus("scheduler", true, true, "heartbeat scheduler running", {
      heartbeatFile,
      intervalMs
    });
  }

  private runBackupPreflight(config: GatewayBackupModuleConfig | undefined): void {
    const enabled = config?.enabled ?? false;
    if (!enabled) {
      this.setStatus("backup", false, true, "disabled");
      return;
    }

    const directory = this.backupDirectory(config);
    ensureDirectory(directory);
    this.setStatus("backup", true, true, "backup directory ready", {
      directory,
      includeObservability: config?.includeObservability ?? true,
      includeSubagents: config?.includeSubagents ?? true
    });
  }

  start(): void {
    this.runMemoryPreflight(this.config?.memory);
    this.runGraphPreflight(this.config?.graph);
    this.runSchedulerPreflight(this.config?.scheduler);
    this.runBackupPreflight(this.config?.backup);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  doctor(): OptionalModuleStatus[] {
    return this.listStatuses();
  }

  listStatuses(): OptionalModuleStatus[] {
    const order: Array<OptionalModuleStatus["module"]> = ["memory", "graph", "scheduler", "backup"];
    return order
      .map((module) => this.statuses.get(module))
      .filter((status): status is OptionalModuleStatus => Boolean(status))
      .map((status) => ({ ...status }));
  }

  createBackup(params?: {
    outputDirectory?: string;
  }): { ok: boolean; message: string; backupPath?: string } {
    const status = this.statuses.get("backup");
    if (!status?.enabled) {
      return {
        ok: false,
        message: "Backup module is disabled"
      };
    }
    if (!status.healthy) {
      return {
        ok: false,
        message: `Backup module is unhealthy: ${status.message}`
      };
    }

    const baseDirectory = params?.outputDirectory
      ? path.resolve(params.outputDirectory)
      : this.backupDirectory(this.config?.backup);
    const backupDirectory = path.join(baseDirectory, `backup-${Date.now()}`);

    try {
      ensureDirectory(backupDirectory);
      const includes = [
        {
          source: path.resolve(this.workspaceDir, ".drost", "sessions"),
          target: path.join(backupDirectory, "sessions")
        },
        {
          source: path.resolve(this.workspaceDir, ".drost", "orchestration-lanes.json"),
          target: path.join(backupDirectory, "orchestration-lanes.json")
        },
        {
          source: path.resolve(this.workspaceDir, ".drost", "restart-history.json"),
          target: path.join(backupDirectory, "restart-history.json")
        }
      ];

      if (this.config?.backup?.includeObservability ?? true) {
        includes.push({
          source: path.resolve(this.workspaceDir, ".drost", "observability"),
          target: path.join(backupDirectory, "observability")
        });
      }
      if (this.config?.backup?.includeSubagents ?? true) {
        includes.push({
          source: path.resolve(this.workspaceDir, ".drost", "subagents"),
          target: path.join(backupDirectory, "subagents")
        });
      }

      for (const include of includes) {
        if (!fs.existsSync(include.source)) {
          continue;
        }
        fs.cpSync(include.source, include.target, {
          recursive: true,
          force: true
        });
      }

      fs.writeFileSync(
        path.join(backupDirectory, "manifest.json"),
        JSON.stringify(
          {
            createdAt: nowIso(),
            workspaceDir: this.workspaceDir,
            includes: includes.map((entry) => path.relative(backupDirectory, entry.target))
          },
          null,
          2
        ),
        "utf8"
      );

      return {
        ok: true,
        message: "Backup created",
        backupPath: backupDirectory
      };
    } catch (error) {
      return {
        ok: false,
        message: `Backup failed: ${toErrorText(error)}`
      };
    }
  }

  restoreBackup(params: {
    backupPath: string;
  }): { ok: boolean; message: string } {
    const status = this.statuses.get("backup");
    if (!status?.enabled) {
      return {
        ok: false,
        message: "Backup module is disabled"
      };
    }
    if (!status.healthy) {
      return {
        ok: false,
        message: `Backup module is unhealthy: ${status.message}`
      };
    }

    const backupPath = path.resolve(params.backupPath);
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
      return {
        ok: false,
        message: `Backup path not found: ${backupPath}`
      };
    }

    try {
      const mapping: Array<{ source: string; target: string }> = [
        {
          source: path.join(backupPath, "sessions"),
          target: path.resolve(this.workspaceDir, ".drost", "sessions")
        },
        {
          source: path.join(backupPath, "orchestration-lanes.json"),
          target: path.resolve(this.workspaceDir, ".drost", "orchestration-lanes.json")
        },
        {
          source: path.join(backupPath, "restart-history.json"),
          target: path.resolve(this.workspaceDir, ".drost", "restart-history.json")
        },
        {
          source: path.join(backupPath, "observability"),
          target: path.resolve(this.workspaceDir, ".drost", "observability")
        },
        {
          source: path.join(backupPath, "subagents"),
          target: path.resolve(this.workspaceDir, ".drost", "subagents")
        }
      ];

      for (const entry of mapping) {
        if (!fs.existsSync(entry.source)) {
          continue;
        }
        ensureDirectory(path.dirname(entry.target));
        fs.cpSync(entry.source, entry.target, {
          recursive: true,
          force: true
        });
      }

      return {
        ok: true,
        message: "Backup restored"
      };
    } catch (error) {
      return {
        ok: false,
        message: `Restore failed: ${toErrorText(error)}`
      };
    }
  }
}

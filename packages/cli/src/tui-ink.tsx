import fs from "node:fs";
import path from "node:path";
import { Box, Text, render, useInput, useStdout, type Instance } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RESTART_EXIT_CODE,
  createGateway,
  type NormalizedStreamEvent,
  type GatewayConfig,
  type GatewayRuntime,
  type GatewayStatus
} from "@drost/core";
import {
  renderCommandHints,
  renderGatewayBoot,
  renderMarkdownToTerminal,
  renderSessionSummary,
  renderStreamEvent,
  type TuiTranscriptEntry
} from "@drost/tui";
import {
  applyStreamEventToConversation,
  createTuiConversationBuffers,
  hydrateSessionHistory,
  pushEventLines,
  pushUserMessage,
  type TuiConversationBuffers
} from "./tui-state.js";

interface SessionSummary {
  sessionId: string;
  activeProviderId: string;
  pendingProviderId?: string;
  turnInProgress: boolean;
  historyCount: number;
  active: boolean;
}

interface GatewayInkAppProps {
  gateway: GatewayRuntime;
  restartCount: number;
  hasProviders: boolean;
  onInterrupt: () => void;
}

interface PendingStreamQueue {
  sessionId: string;
  providerId: string;
  text: string;
  pendingCompleted?: NormalizedStreamEvent;
}

type ThemeMode = "dark" | "light";

type Theme = {
  accent: string;
  muted: string;
  faint: string;
  border: string;
  warn: string;
  error: string;
  ok: string;
};

const THEMES: Record<ThemeMode, Theme> = {
  dark: {
    accent: "#2DD4BF",
    muted: "#94A3B8",
    faint: "#64748B",
    border: "#334155",
    warn: "#F59E0B",
    error: "#EF4444",
    ok: "#22C55E"
  },
  light: {
    accent: "#0F766E",
    muted: "#475569",
    faint: "#64748B",
    border: "#CBD5E1",
    warn: "#B45309",
    error: "#B91C1C",
    ok: "#15803D"
  }
};

function ensurePidDir(pidFilePath: string): void {
  fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
}

function writePidFile(pidFilePath: string): void {
  ensurePidDir(pidFilePath);
  fs.writeFileSync(pidFilePath, `${process.pid}\n`);
}

function removePidFile(pidFilePath: string): void {
  try {
    fs.rmSync(pidFilePath, { force: true });
  } catch {
    // best effort
  }
}

function normalizeEventLine(line: string): string {
  return line.startsWith("[drost] ") ? line.slice("[drost] ".length) : line;
}

function parseToolCommand(raw: string): { toolName: string; input: unknown } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { error: "tool name required" };
  }

  const firstSpace = trimmed.indexOf(" ");
  const toolName = firstSpace >= 0 ? trimmed.slice(0, firstSpace).trim() : trimmed;
  const rawJson = firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : "";
  if (!toolName) {
    return { error: "tool name required" };
  }

  if (!rawJson) {
    return {
      toolName,
      input: {}
    };
  }

  try {
    return {
      toolName,
      input: JSON.parse(rawJson)
    };
  } catch (error) {
    return {
      error: `invalid tool json: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function summarizeToolValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function loadSessions(gateway: GatewayRuntime, activeSessionId: string): void {
  gateway.ensureSession(activeSessionId);
  const persistedSessionIds = gateway.listPersistedSessionIds();
  for (const sessionId of persistedSessionIds) {
    if (sessionId === activeSessionId) {
      continue;
    }
    gateway.ensureSession(sessionId);
  }
}

function hydrateTranscriptFromSessions(gateway: GatewayRuntime, buffers: TuiConversationBuffers): void {
  const snapshots = gateway
    .listSessionSnapshots()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  for (const session of snapshots) {
    hydrateSessionHistory(buffers, {
      sessionId: session.sessionId,
      providerId: session.activeProviderId,
      history: gateway.getSessionHistory(session.sessionId)
    });
  }
}

function buildSessionSummaries(gateway: GatewayRuntime, activeSessionId: string): SessionSummary[] {
  return gateway
    .listSessionSnapshots()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map((session) => ({
      ...session,
      active: session.sessionId === activeSessionId
    }));
}

function formatGatewayState(status: GatewayStatus): { label: string; color: "green" | "yellow" | "red" } {
  if (status.state === "degraded") {
    return { label: "degraded", color: "yellow" };
  }
  if (status.state === "running") {
    return { label: "running", color: "green" };
  }
  return { label: status.state, color: "red" };
}

function toolCount(status: GatewayStatus): number {
  const diagnostics = status.toolDiagnostics;
  if (!diagnostics) {
    return 0;
  }
  return diagnostics.loadedBuiltInCount + diagnostics.loadedCustomCount;
}

function probeSummary(status: GatewayStatus): { ok: number; fail: number } {
  const diagnostics = status.providerDiagnostics ?? [];
  let ok = 0;
  let fail = 0;
  for (const probe of diagnostics) {
    if (probe.ok) {
      ok += 1;
    } else {
      fail += 1;
    }
  }
  return { ok, fail };
}

function eventColor(line: string): "white" | "yellow" | "red" {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("failed")) {
    return "red";
  }
  if (lower.includes("degraded") || lower.includes("missing") || lower.includes("warn")) {
    return "yellow";
  }
  return "white";
}

function eventThemeColor(theme: Theme, line: string): string {
  const tone = eventColor(line);
  if (tone === "red") {
    return theme.error;
  }
  if (tone === "yellow") {
    return theme.warn;
  }
  return theme.muted;
}

const STREAM_TICK_MS = 24;

function toTranscriptLines(
  entries: TuiTranscriptEntry[],
  maxEntries: number
): Array<{
  id: string;
  role: TuiTranscriptEntry["role"];
  sessionId: string;
  providerId?: string;
  text: string;
  usage?: string;
  streaming?: boolean;
}> {
  const selected = entries.slice(-maxEntries);
  return selected.map((entry) => ({
    id: entry.id,
    role: entry.role,
    sessionId: entry.sessionId,
    providerId: entry.providerId,
    text:
      entry.role === "user" || entry.role === "assistant"
        ? renderMarkdownToTerminal((entry.text || "(waiting for response)").replace(/\r/g, ""))
        : (entry.text || "(waiting for response)").replace(/\r/g, ""),
    usage: entry.usage,
    streaming: entry.streaming
  }));
}

function GatewayInkApp(props: GatewayInkAppProps): React.JSX.Element {
  const [activeSessionId, setActiveSessionId] = useState("local");
  const [turnInFlight, setTurnInFlight] = useState(false);
  const [input, setInput] = useState("");
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [viewport, setViewport] = useState({
    width: process.stdout.columns ?? 120,
    height: process.stdout.rows ?? 40
  });

  const activeSessionRef = useRef("local");
  const inputRef = useRef("");
  const turnInFlightRef = useRef(false);
  const buffersRef = useRef<TuiConversationBuffers>(createTuiConversationBuffers());
  const streamQueueRef = useRef<Map<string, PendingStreamQueue>>(new Map());
  const streamPumpTimerRef = useRef<NodeJS.Timeout | null>(null);
  const { stdout } = useStdout();

  const forceRender = useCallback(() => {
    setRefreshVersion((value) => value + 1);
  }, []);

  const setTurnState = useCallback((value: boolean) => {
    turnInFlightRef.current = value;
    setTurnInFlight(value);
  }, []);

  const pushEvents = useCallback(
    (lines: string[]) => {
      pushEventLines(
        buffersRef.current,
        lines.map((line) => normalizeEventLine(line))
      );
      forceRender();
    },
    [forceRender]
  );

  const renderSignalEvent = useCallback((event: NormalizedStreamEvent): void => {
    pushEventLines(buffersRef.current, [
      normalizeEventLine(
        renderStreamEvent({
          type: event.type,
          sessionId: event.sessionId,
          providerId: event.providerId,
          payload: {
            text: event.payload.text,
            error: event.payload.error,
            toolName: event.payload.toolName,
            metadata: event.payload.metadata,
            usage: event.payload.usage
          }
        })
      )
    ]);
  }, []);

  const applyConversationEvent = useCallback(
    (event: NormalizedStreamEvent, options?: { includeSignalLog?: boolean }) => {
      applyStreamEventToConversation(buffersRef.current, event);
      if (event.type !== "response.delta" && options?.includeSignalLog !== false) {
        renderSignalEvent(event);
      }
    },
    [renderSignalEvent]
  );

  const stopStreamPump = useCallback(() => {
    if (!streamPumpTimerRef.current) {
      return;
    }
    clearInterval(streamPumpTimerRef.current);
    streamPumpTimerRef.current = null;
  }, []);

  const flushQueuedSession = useCallback(
    (sessionId: string): void => {
      const queue = streamQueueRef.current.get(sessionId);
      if (!queue) {
        return;
      }
      if (queue.text.length > 0) {
        applyConversationEvent(
          {
            type: "response.delta",
            sessionId: queue.sessionId,
            providerId: queue.providerId,
            timestamp: new Date().toISOString(),
            payload: {
              text: queue.text
            }
          },
          {
            includeSignalLog: false
          }
        );
        queue.text = "";
      }
      if (queue.pendingCompleted) {
        applyConversationEvent(queue.pendingCompleted);
      }
      streamQueueRef.current.delete(sessionId);
    },
    [applyConversationEvent]
  );

  const processQueuedDeltaTick = useCallback((): void => {
    if (streamQueueRef.current.size === 0) {
      stopStreamPump();
      return;
    }

    let changed = false;
    for (const [sessionId, queue] of streamQueueRef.current) {
      if (queue.text.length > 0) {
        const chunkSize = Math.max(2, Math.min(96, Math.ceil(queue.text.length / 30)));
        const chunk = queue.text.slice(0, chunkSize);
        queue.text = queue.text.slice(chunkSize);
        applyConversationEvent(
          {
            type: "response.delta",
            sessionId: queue.sessionId,
            providerId: queue.providerId,
            timestamp: new Date().toISOString(),
            payload: {
              text: chunk
            }
          },
          {
            includeSignalLog: false
          }
        );
        changed = true;
      }

      if (queue.text.length === 0 && queue.pendingCompleted) {
        applyConversationEvent(queue.pendingCompleted);
        streamQueueRef.current.delete(sessionId);
        changed = true;
      }
    }

    if (streamQueueRef.current.size === 0) {
      stopStreamPump();
    }

    if (changed) {
      forceRender();
    }
  }, [applyConversationEvent, forceRender, stopStreamPump]);

  const ensureStreamPump = useCallback((): void => {
    if (streamPumpTimerRef.current) {
      return;
    }
    streamPumpTimerRef.current = setInterval(() => {
      processQueuedDeltaTick();
    }, STREAM_TICK_MS);
  }, [processQueuedDeltaTick]);

  const queueDeltaEvent = useCallback(
    (event: NormalizedStreamEvent): void => {
      const existing = streamQueueRef.current.get(event.sessionId);
      const queue: PendingStreamQueue = existing ?? {
        sessionId: event.sessionId,
        providerId: event.providerId,
        text: ""
      };
      queue.providerId = event.providerId;
      queue.text += event.payload.text ?? "";
      streamQueueRef.current.set(event.sessionId, queue);
      ensureStreamPump();
      processQueuedDeltaTick();
    },
    [ensureStreamPump, processQueuedDeltaTick]
  );

  const handleGatewayStreamEvent = useCallback(
    (event: NormalizedStreamEvent): void => {
      if (event.type === "response.delta") {
        queueDeltaEvent(event);
        return;
      }

      if (event.type === "response.completed") {
        const queue = streamQueueRef.current.get(event.sessionId);
        if (queue) {
          queue.pendingCompleted = event;
          streamQueueRef.current.set(event.sessionId, queue);
          ensureStreamPump();
          processQueuedDeltaTick();
          return;
        }
      }

      if (event.type === "provider.error") {
        flushQueuedSession(event.sessionId);
      }

      applyConversationEvent(event);
      forceRender();
    },
    [
      applyConversationEvent,
      ensureStreamPump,
      flushQueuedSession,
      forceRender,
      processQueuedDeltaTick,
      queueDeltaEvent
    ]
  );

  useEffect(() => {
    if (props.hasProviders) {
      loadSessions(props.gateway, "local");
      hydrateTranscriptFromSessions(props.gateway, buffersRef.current);
      pushEvents(["local session ready"]);
      forceRender();
    } else {
      pushEvents(["no providers configured. Waiting for signals."]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!turnInFlight) {
      setSpinnerFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setSpinnerFrame((index) => (index + 1) % 10);
    }, 120);

    return () => {
      clearInterval(timer);
    };
  }, [turnInFlight]);

  useEffect(() => {
    const onResize = (): void => {
      setViewport({
        width: stdout.columns ?? process.stdout.columns ?? 120,
        height: stdout.rows ?? process.stdout.rows ?? 40
      });
    };

    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    return () => {
      stopStreamPump();
      streamQueueRef.current.clear();
    };
  }, [stopStreamPump]);

  const runTextTurn = useCallback(
    (text: string): void => {
      if (!props.hasProviders) {
        pushEvents(["no providers configured in drost.config.*"]);
        return;
      }

      if (turnInFlightRef.current) {
        pushEvents(["turn already in progress"]);
        return;
      }

      const currentSessionId = activeSessionRef.current;
      const currentSession = props.gateway.getSessionState(currentSessionId);
      pushUserMessage(buffersRef.current, {
        sessionId: currentSessionId,
        providerId: currentSession?.pendingProviderId ?? currentSession?.activeProviderId ?? "unknown",
        text
      });
      setTurnState(true);
      forceRender();

      void props.gateway
        .runSessionTurn({
          sessionId: currentSessionId,
          input: text,
          onEvent: handleGatewayStreamEvent
        })
        .catch((error) => {
          pushEvents([error instanceof Error ? error.message : String(error)]);
        })
        .finally(() => {
          setTurnState(false);
          forceRender();
        });
    },
    [forceRender, handleGatewayStreamEvent, props.gateway, props.hasProviders, pushEvents, setTurnState]
  );

  const runToolInvocation = useCallback(
    (toolName: string, inputValue: unknown): void => {
      if (turnInFlightRef.current) {
        pushEvents(["turn already in progress"]);
        return;
      }

      setTurnState(true);
      forceRender();

      void props.gateway
        .runTool({
          sessionId: activeSessionRef.current,
          toolName,
          input: inputValue,
          onEvent: (event) => {
            pushEventLines(buffersRef.current, [
              normalizeEventLine(
                renderStreamEvent({
                  type: event.type,
                  sessionId: event.sessionId,
                  providerId: event.providerId,
                  payload: {
                    text: event.payload.text,
                    error: event.payload.error,
                    toolName: event.payload.toolName,
                    metadata: event.payload.metadata,
                    usage: event.payload.usage
                  }
                })
              )
            ]);
            forceRender();
          }
        })
        .then((result) => {
          if (result.ok) {
            pushEvents([`tool ${result.toolName} output: ${summarizeToolValue(result.output)}`]);
            return;
          }
          const lines: string[] = [
            `tool ${result.toolName} ${result.error?.code ?? "error"}: ${result.error?.message ?? "unknown error"}`
          ];
          for (const issue of result.error?.issues ?? []) {
            lines.push(`issue ${issue.path}: ${issue.message}`);
          }
          pushEvents(lines);
        })
        .catch((error) => {
          pushEvents([error instanceof Error ? error.message : String(error)]);
        })
        .finally(() => {
          setTurnState(false);
          forceRender();
        });
    },
    [forceRender, props.gateway, pushEvents, setTurnState]
  );

  const handleCommand = useCallback(
    (rawText: string): void => {
      const text = rawText.trim();
      if (!text) {
        return;
      }

      if (text === "/help") {
        pushEvents([renderCommandHints()]);
        return;
      }

      if (text === "/restart") {
        void props.gateway
          .requestRestart({
            intent: "manual",
            reason: "/restart command"
          })
          .then((result) => {
            if (result && typeof result === "object" && "ok" in result && result.ok === false) {
              pushEvents([`restart blocked: ${result.message}`]);
            }
          })
          .catch((error) => {
            pushEvents([error instanceof Error ? error.message : String(error)]);
          });
        return;
      }

      if (text.startsWith("/provider ")) {
        const providerId = text.slice("/provider ".length).trim();
        if (!providerId) {
          pushEvents(["provider id required"]);
          return;
        }
        if (!props.hasProviders) {
          pushEvents(["no providers configured in drost.config.*"]);
          return;
        }
        try {
          props.gateway.queueSessionProviderSwitch(activeSessionRef.current, providerId);
          const session = props.gateway.getSessionState(activeSessionRef.current);
          pushEvents([
            `provider queued for next turn in session ${activeSessionRef.current}: ${providerId} (active: ${session?.activeProviderId ?? "n/a"})`
          ]);
        } catch (error) {
          pushEvents([error instanceof Error ? error.message : String(error)]);
        }
        return;
      }

      if (text === "/session") {
        if (!props.hasProviders) {
          pushEvents(["no providers configured in drost.config.*"]);
          return;
        }
        const session = props.gateway.getSessionState(activeSessionRef.current);
        pushEvents([
          `active session=${activeSessionRef.current} provider=${session?.activeProviderId ?? "n/a"} pending=${session?.pendingProviderId ?? "(none)"}`
        ]);
        return;
      }

      if (text.startsWith("/session ")) {
        if (!props.hasProviders) {
          pushEvents(["no providers configured in drost.config.*"]);
          return;
        }
        const nextSessionId = text.slice("/session ".length).trim();
        if (!nextSessionId) {
          pushEvents(["session id required"]);
          return;
        }
        try {
          props.gateway.ensureSession(nextSessionId);
          setActiveSessionId(nextSessionId);
          activeSessionRef.current = nextSessionId;
          const session = props.gateway.getSessionState(nextSessionId);
          pushEvents([
            `active session switched to ${nextSessionId} (provider=${session?.activeProviderId ?? "n/a"})`
          ]);
          forceRender();
        } catch (error) {
          pushEvents([error instanceof Error ? error.message : String(error)]);
        }
        return;
      }

      if (text === "/sessions") {
        if (!props.hasProviders) {
          pushEvents(["no providers configured in drost.config.*"]);
          return;
        }
        pushEvents(
          renderSessionSummary(buildSessionSummaries(props.gateway, activeSessionRef.current)).map((line) =>
            normalizeEventLine(line)
          )
        );
        return;
      }

      if (text === "/status") {
        const status = props.gateway.getStatus();
        const lines = renderGatewayBoot({
          state: status.state,
          startedAt: status.startedAt,
          degradedReasons: status.degradedReasons,
          restartCount: props.restartCount,
          healthUrl: status.healthUrl
        }).map((line) => normalizeEventLine(line));

        if (props.hasProviders) {
          lines.push(
            ...renderSessionSummary(buildSessionSummaries(props.gateway, activeSessionRef.current)).map((line) =>
              normalizeEventLine(line)
            )
          );
        }
        pushEvents(lines);
        return;
      }

      if (text === "/providers") {
        const profiles = props.gateway.listProviderProfiles();
        if (profiles.length === 0) {
          pushEvents(["no provider profiles configured"]);
          return;
        }
        pushEvents(
          profiles.map(
            (profile) =>
              `provider=${profile.id} kind=${profile.kind} model=${profile.model} auth=${profile.authProfileId}`
          )
        );
        return;
      }

      if (text === "/tools") {
        const toolNames = props.gateway.listLoadedToolNames();
        if (toolNames.length === 0) {
          pushEvents(["no tools loaded"]);
          return;
        }
        pushEvents([`loaded tools: ${toolNames.join(", ")}`]);
        return;
      }

      if (text.startsWith("/tool ")) {
        const parsed = parseToolCommand(text.slice("/tool ".length));
        if ("error" in parsed) {
          pushEvents([parsed.error]);
          return;
        }
        runToolInvocation(parsed.toolName, parsed.input);
        return;
      }

      runTextTurn(text);
    },
    [forceRender, props.gateway, props.hasProviders, props.restartCount, pushEvents, runTextTurn, runToolInvocation]
  );

  useInput(
    (value, key) => {
      if (key.ctrl && value.toLowerCase() === "c") {
        props.onInterrupt();
        return;
      }

      if (key.return) {
        const submitted = inputRef.current.replace(/[\r\n]+/g, " ").trim();
        setInput("");
        if (submitted.length > 0) {
          handleCommand(submitted);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
        return;
      }

      if (key.escape) {
        setInput("");
        return;
      }

      if (key.tab) {
        pushEvents(["signals pane focus switch is coming soon"]);
        return;
      }

      if (!key.ctrl && !key.meta && value) {
        setInput((current) => current + value);
      }
    },
    {
      isActive: true
    }
  );

  const status = props.gateway.getStatus();
  const state = formatGatewayState(status);
  const probes = probeSummary(status);
  const tools = toolCount(status);
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinnerGlyph = spinnerFrames[spinnerFrame % spinnerFrames.length] ?? "⠋";
  const theme = THEMES.dark;

  const sessions = useMemo(
    () => (props.hasProviders ? buildSessionSummaries(props.gateway, activeSessionId) : []),
    [activeSessionId, props.gateway, props.hasProviders, refreshVersion]
  );
  const activeSession = sessions.find((session) => session.active);
  const failedProbes = (status.providerDiagnostics ?? []).filter((probe) => !probe.ok);
  const events = buffersRef.current.events;

  const statusLineCount =
    2 +
    (status.degradedReasons?.length ?? 0) +
    failedProbes.length;

  const rows = Math.max(24, viewport.height);
  const transcriptRows = Math.max(8, rows - (statusLineCount + 12));
  const transcriptLines = toTranscriptLines(buffersRef.current.transcript, transcriptRows);
  const signalLines = events.slice(-Math.max(4, Math.min(10, Math.floor(rows / 4))));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Box flexDirection="row">
            <Text bold color={theme.accent}>drost</Text>
            <Text>{` `}</Text>
            <Text color={state.label === "running" ? theme.ok : state.label === "degraded" ? theme.warn : theme.error}>
              {state.label}
            </Text>
            <Text>{` `}</Text>
            <Text color={theme.muted}>{`restart=${props.restartCount}`}</Text>
            <Text>{` `}</Text>
            <Text color={theme.faint}>{`health=${status.healthUrl ?? "disabled"}`}</Text>
          </Box>
          <Text color={turnInFlight ? theme.warn : theme.faint}>{turnInFlight ? `turn=running ${spinnerGlyph}` : "turn=idle"}</Text>
        </Box>

        <Text color={theme.faint}>{`session=${activeSessionId} provider=${activeSession?.activeProviderId ?? "n/a"} pending=${activeSession?.pendingProviderId ?? "(none)"}`}</Text>
        <Text color={theme.faint}>{`providers=${status.providerDiagnostics?.length ?? 0} probes_ok=${probes.ok} probes_fail=${probes.fail} tools=${tools} events=${events.length}`}</Text>

        {(status.degradedReasons ?? []).map((reason, index) => (
          <Text key={`degraded-${index}`} color={theme.warn}>
            {`! ${reason}`}
          </Text>
        ))}

        {failedProbes.map((probe) => (
          <Text key={`probe-fail-${probe.providerId}`} color={theme.warn}>
            {`! probe ${probe.providerId}: ${probe.code} - ${probe.message}`}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.accent}>Conversation</Text>

        {transcriptLines.length === 0 ? (
          <Text color={theme.faint}>No conversation yet. Type a message below.</Text>
        ) : (
          (() => {
            let lastAssistantSource = "";
            return transcriptLines.map((line) => {
              if (line.role === "user") {
                return (
                  <Box key={line.id} flexDirection="row">
                    <Text color={theme.accent}>{"> "}</Text>
                    <Text>{line.text}</Text>
                  </Box>
                );
              }

              if (line.role === "error") {
                return (
                  <Box key={line.id} marginBottom={1}>
                    <Text color={theme.error}>{line.text}</Text>
                  </Box>
                );
              }

              if (line.role === "system") {
                return (
                  <Box key={line.id} flexDirection="column" marginBottom={1}>
                    <Text color={theme.faint}>{`system · ${line.sessionId}`}</Text>
                    <Text color={theme.muted}>{line.text}</Text>
                  </Box>
                );
              }

              const source = `${line.providerId ?? activeSession?.activeProviderId ?? "n/a"} · ${line.sessionId}`;
              const showSource = source !== lastAssistantSource;
              lastAssistantSource = source;

              return (
                <Box key={line.id} flexDirection="column" marginBottom={1}>
                  {showSource ? <Text color={theme.faint}>{`drost · ${source}`}</Text> : null}
                  <Text>{line.text}</Text>
                  {line.usage ? <Text color={theme.faint}>{line.usage}</Text> : null}
                  {line.streaming ? <Text color={theme.warn}>{`streaming ${spinnerGlyph}`}</Text> : null}
                </Box>
              );
            });
          })()
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.faint}>{`Signals (${signalLines.length}/${events.length})`}</Text>
        {signalLines.length === 0 ? (
          <Text color={theme.faint}>No signals yet.</Text>
        ) : (
          signalLines.map((line, index) => (
            <Text key={`event-${index}`} color={eventThemeColor(theme, line)}>
              {line}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box flexDirection="row">
          <Text color={turnInFlight ? theme.warn : theme.accent}>{"> "}</Text>
          {input.length > 0 ? <Text>{input}</Text> : <Text color={theme.faint}>Type message or /help</Text>}
          <Text inverse color={turnInFlight ? theme.warn : theme.accent}> </Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color={theme.faint}>Enter send | Esc clear | Ctrl+C quit</Text>
          <Text color={theme.faint}>/providers /provider /sessions /session /status /tools /tool /help /restart</Text>
        </Box>
      </Box>
    </Box>
  );
}

export async function runGatewayCycleTuiInk(params: {
  config: GatewayConfig;
  pidFilePath: string;
  restartCount: number;
}): Promise<number> {
  let settled = false;
  let keepAliveTimer: NodeJS.Timeout | null = null;
  let inkApp: Instance | null = null;

  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const settle = (code: number): void => {
    if (settled) {
      return;
    }

    settled = true;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("SIGUSR2", onSigUsr2);

    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    if (inkApp) {
      inkApp.unmount();
      inkApp = null;
    }

    resolveExit(code);
  };

  const gateway = createGateway(params.config, {
    exit: (code) => {
      settle(code);
    }
  });

  await gateway.start();
  writePidFile(params.pidFilePath);

  const hasProviders = Boolean(params.config.providers && params.config.providers.profiles.length > 0);

  const onSigInt = async (): Promise<void> => {
    await gateway.stop();
    settle(0);
  };

  const onSigTerm = async (): Promise<void> => {
    await gateway.stop();
    settle(0);
  };

  const onSigUsr2 = async (): Promise<void> => {
    await gateway.requestRestart({
      intent: "signal",
      reason: "SIGUSR2"
    });
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGUSR2", onSigUsr2);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    inkApp = render(
      <GatewayInkApp
        gateway={gateway}
        restartCount={params.restartCount}
        hasProviders={hasProviders}
        onInterrupt={() => {
          void onSigInt();
        }}
      />,
      {
        patchConsole: false,
        exitOnCtrlC: false
      }
    );
  } else {
    keepAliveTimer = setInterval(() => {}, 60_000);
  }

  const exitCode = await exitPromise;
  if (exitCode !== RESTART_EXIT_CODE) {
    removePidFile(params.pidFilePath);
  }
  return exitCode;
}

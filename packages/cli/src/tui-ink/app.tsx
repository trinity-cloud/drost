import { Box, Text, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type NormalizedStreamEvent,
  type GatewayRuntime
} from "@drost/core";
import {
  renderStreamEvent,
} from "@drost/tui";
import {
  applyStreamEventToConversation,
  createTuiConversationBuffers,
  pushEventLines,
  pushUserMessage,
  type TuiConversationBuffers
} from "../tui-state.js";
import { summarizeToolValue } from "../runtime-common.js";
import { handleTuiCommand } from "./command-handler.js";
import {
  THEMES,
  bootstrapSessions,
  eventThemeColor,
  formatGatewayState,
  hydrateTranscriptFromSessions,
  normalizeEventLine,
  probeSummary,
  summarizeSessions,
  toTranscriptLines,
  toolCount
} from "./helpers.js";

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

const STREAM_TICK_MS = 24;

export function GatewayInkApp(props: GatewayInkAppProps): React.JSX.Element {
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
      bootstrapSessions(props.gateway, "local");
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
      handleTuiCommand({
        rawText,
        hasProviders: props.hasProviders,
        gateway: props.gateway,
        restartCount: props.restartCount,
        activeSessionId: activeSessionRef.current,
        setActiveSessionId: (sessionId) => {
          setActiveSessionId(sessionId);
          activeSessionRef.current = sessionId;
        },
        pushEvents,
        forceRender,
        runToolInvocation,
        runTextTurn
      });
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
    () => (props.hasProviders ? summarizeSessions(props.gateway, activeSessionId) : []),
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
          <Text color={theme.faint}>/providers /provider /sessions /session /new /status /tools /tool /help /restart</Text>
        </Box>
      </Box>
    </Box>
  );
}

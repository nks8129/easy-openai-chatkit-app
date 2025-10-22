"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";
import {
  STARTER_PROMPTS,
  PLACEHOLDER_INPUT,
  GREETING,
  CREATE_SESSION_ENDPOINT,
  WORKFLOW_ID,
  getThemeConfig,
} from "@/lib/config";
import { ErrorOverlay } from "./ErrorOverlay";
import type { ColorScheme } from "@/hooks/useColorScheme";

export type FactAction = { type: "save"; factId: string; factText: string };

type ChatKitPanelProps = {
  theme: ColorScheme;
  onWidgetAction: (action: FactAction) => Promise<void>;
  onResponseEnd: () => void;
  onThemeRequest: (scheme: ColorScheme) => void;
};

type ErrorState = {
  script: string | null;
  session: string | null;
  integration: string | null;
  retryable: boolean;
};

const isBrowser = typeof window !== "undefined";
const isDev = process.env.NODE_ENV !== "production";

const createInitialErrors = (): ErrorState => ({
  script: null,
  session: null,
  integration: null,
  retryable: false,
});

export function ChatKitPanel({
  theme,
  onWidgetAction,
  onResponseEnd,
  onThemeRequest,
}: ChatKitPanelProps) {
  const processedFacts = useRef(new Set<string>());
  const [errors, setErrors] = useState<ErrorState>(() => createInitialErrors());
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const isMountedRef = useRef(true);
  const [scriptStatus, setScriptStatus] = useState<"pending" | "ready" | "error">(
    () => (isBrowser && (window as any).customElements?.get("openai-chatkit") ? "ready" : "pending")
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  // prevent sendUserMessage while model is streaming
  const isRespondingRef = useRef(false);
  const queuedClickRef = useRef<string | null>(null);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // script load status (for the overlay)
  useEffect(() => {
    if (!isBrowser) return;

    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) return;
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (event: Event) => {
      console.error("Failed to load chatkit.js", event);
      if (!isMountedRef.current) return;
      setScriptStatus("error");
      const detail = (event as CustomEvent<unknown>)?.detail ?? "unknown error";
      setErrorState({ script: `Error: ${detail}`, retryable: false });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener("chatkit-script-error", handleError as EventListener);

    if ((window as any).customElements?.get("openai-chatkit")) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!(window as any).customElements?.get("openai-chatkit")) {
          handleError(new CustomEvent("chatkit-script-error", {
            detail: "ChatKit web component is unavailable. Verify the script URL.",
          }));
        }
      }, 5000);
    }

    return () => {
      window.removeEventListener("chatkit-script-loaded", handleLoaded);
      window.removeEventListener("chatkit-script-error", handleError as EventListener);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [scriptStatus, setErrorState]);

  const isWorkflowConfigured = Boolean(WORKFLOW_ID && !WORKFLOW_ID.startsWith("wf_replace"));

  useEffect(() => {
    if (!isWorkflowConfigured && isMountedRef.current) {
      setErrorState({
        session: "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.",
        retryable: false,
      });
      setIsInitializingSession(false);
    }
  }, [isWorkflowConfigured, setErrorState]);

  const handleResetChat = useCallback(() => {
    processedFacts.current.clear();
    if (isBrowser) {
      setScriptStatus((window as any).customElements?.get("openai-chatkit") ? "ready" : "pending");
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  // Create ChatKit session
  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (isDev) {
        console.info("[ChatKitPanel] getClientSecret", {
          currentSecretPresent: Boolean(currentSecret),
          workflowId: WORKFLOW_ID,
          endpoint: CREATE_SESSION_ENDPOINT,
        });
      }

      if (!isWorkflowConfigured) {
        const detail = "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
          setIsInitializingSession(false);
        }
        throw new Error(detail);
      }

      if (isMountedRef.current) {
        if (!currentSecret) setIsInitializingSession(true);
        setErrorState({ session: null, integration: null, retryable: false });
      }

      try {
        const response = await fetch(CREATE_SESSION_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflow: { id: WORKFLOW_ID },
            chatkit_configuration: {
              file_upload: { enabled: true },
              widgets: { enabled: true },
            },
          }),
        });

        const raw = await response.text();
        let data: Record<string, unknown> = {};
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch (e) {
            console.error("create-session JSON parse error", e);
          }
        }

        if (!response.ok) {
          const detail = extractErrorDetail(data, response.statusText);
          console.error("Create session failed", { status: response.status, body: data });
          throw new Error(detail);
        }

        const clientSecret = (data?.client_secret as string) ?? "";
        if (!clientSecret) throw new Error("Missing client secret in response");

        if (isMountedRef.current) setErrorState({ session: null, integration: null });
        return clientSecret;
      } catch (error) {
        console.error("Failed to create ChatKit session", error);
        const detail = error instanceof Error ? error.message : "Unable to start ChatKit session.";
        if (isMountedRef.current) setErrorState({ session: detail, retryable: false });
        throw error instanceof Error ? error : new Error(detail);
      } finally {
        if (isMountedRef.current && !currentSecret) setIsInitializingSession(false);
      }
    },
    [isWorkflowConfigured, setErrorState]
  );

  // Hook up ChatKit
  const {
    control,
    sendUserMessage,
    sendAction,
  } = useChatKit({
    api: { getClientSecret },
    theme: { colorScheme: theme, ...getThemeConfig(theme) },
    startScreen: { greeting: GREETING, prompts: STARTER_PROMPTS },
    composer: { placeholder: PLACEHOLDER_INPUT, attachments: { enabled: true } },
    threadItemActions: { feedback: false },

    // Handle widget clicks
    widgets: {
      onAction: async (action, item) => {
        if (isDev) console.debug("[widgets.onAction]", action, item);

        // We don't rely on a specific type; accept any and derive text
        const text =
          (action?.payload as any)?.text ??
          (action?.payload as any)?.label ??
          (action?.payload as any)?.value ??
          action?.type ??
          "";

        if (!text) return true;

        // If a model response is streaming, queue the click
        if (isRespondingRef.current) {
          queuedClickRef.current = String(text);
          if (isDev) console.debug("[widgets.onAction] queued:", queuedClickRef.current);
          return true;
        }

        try {
          await sendUserMessage({ text: String(text) });
        } catch (e) {
          console.error("sendUserMessage failed", e);
        }

        // Optional: also notify backend workflow (Action handler)
        try {
          await sendAction({ type: action.type, payload: action.payload ?? {} });
        } catch (e) {
          if (isDev) console.warn("sendAction failed (no server handler?)", e);
        }

        return true;
      },
    },

    // Client tools from your app
    onClientTool: async (invocation) => {
      if (invocation.name === "switch_theme") {
        const requested = (invocation.params as any).theme;
        if (requested === "light" || requested === "dark") {
          onThemeRequest(requested);
          return { success: true };
        }
        return { success: false };
      }

      if (invocation.name === "record_fact") {
        const id = String((invocation.params as any).fact_id ?? "");
        const text = String((invocation.params as any).fact_text ?? "");
        if (!id || processedFacts.current.has(id)) return { success: true };
        processedFacts.current.add(id);
        void onWidgetAction({ type: "save", factId: id, factText: text.replace(/\s+/g, " ").trim() });
        return { success: true };
      }

      return { success: false };
    },

    // keep local responding state in sync
    onResponseStart: () => {
      isRespondingRef.current = true;
      setErrorState({ integration: null, retryable: false });
    },
    onResponseEnd: async () => {
      isRespondingRef.current = false;
      onResponseEnd();
      if (queuedClickRef.current) {
        const text = queuedClickRef.current;
        queuedClickRef.current = null;
        try {
          await sendUserMessage({ text });
        } catch (e) {
          console.error("sendUserMessage (flush) failed", e);
        }
      }
    },

    onThreadChange: () => {
      processedFacts.current.clear();
    },

    // very helpful for debugging
    onLog: ({ name, data }) => {
      if (isDev) console.debug("[chatkit.log]", name, data);
    },

    onError: ({ error }) => {
      console.error("ChatKit error", error);
    },
  });

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (isDev) {
    console.debug("[ChatKitPanel] render", {
      isInitializingSession,
      hasControl: Boolean(control),
      scriptStatus,
      hasError: Boolean(blockingError),
      workflowId: WORKFLOW_ID,
    });
  }

  return (
    <div className="relative pb-8 flex h-[90vh] w-full rounded-2xl flex-col overflow-hidden bg-white shadow-sm transition-colors dark:bg-slate-900">
      <ChatKit
        key={widgetInstanceKey}
        control={control}
        className={
          blockingError || isInitializingSession ? "pointer-events-none opacity-0" : "block h-full w-full"
        }
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={
          blockingError || !isInitializingSession ? null : "Loading assistant session..."
        }
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}

function extractErrorDetail(payload: Record<string, unknown> | undefined, fallback: string): string {
  if (!payload) return fallback;
  const error = (payload as any)?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as any).message === "string") {
    return (error as any).message;
  }
  const details = (payload as any)?.details;
  if (typeof details === "string") return details;
  if (details && typeof details === "object" && "error" in details) {
    const nested = (details as any).error;
    if (typeof nested === "string") return nested;
    if (nested && typeof nested === "object" && "message" in nested && typeof (nested as any).message === "string") {
      return (nested as any).message;
    }
  }
  if (typeof (payload as any)?.message === "string") return (payload as any).message;
  return fallback;
}

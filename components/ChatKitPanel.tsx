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
  const [scriptStatus, setScriptStatus] = useState<"pending" | "ready" | "error">(() =>
    isBrowser && window.customElements?.get("openai-chatkit") ? "ready" : "pending"
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => () => { isMountedRef.current = false }, []);

  // Load status of chatkit web component (unchanged)
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
      const detail = (event as CustomEvent)?.detail ?? "unknown error";
      setErrorState({ script: `Error: ${detail}`, retryable: false });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener("chatkit-script-error", handleError as EventListener);

    if (window.customElements?.get("openai-chatkit")) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!window.customElements?.get("openai-chatkit")) {
          handleError(new CustomEvent("chatkit-script-error", {
            detail: "ChatKit web component is unavailable. Verify that the script URL is reachable.",
          }) as any);
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
      setScriptStatus(window.customElements?.get("openai-chatkit") ? "ready" : "pending");
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  // --- Hosted session creation (unchanged, but widgets enabled on the server route) ---
  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (isDev) {
        console.info("[ChatKitPanel] getClientSecret invoked", {
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
            // we also turn this on on the server route, this copy here is harmless
            chatkit_configuration: {
              file_upload: { enabled: true },
              widgets: { enabled: true },
            },
          }),
        });

        const raw = await response.text();
        let data: Record<string, unknown> = {};
        if (raw) {
          try { data = JSON.parse(raw) as Record<string, unknown>; }
          catch (e) { console.error("Failed to parse create-session response", e); }
        }

        if (!response.ok) {
          const detail = extractErrorDetail(data, response.statusText);
          console.error("Create session request failed", { status: response.status, body: data });
          throw new Error(detail);
        }

        const clientSecret = (data as any)?.client_secret as string | undefined;
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

  // ---- CLICK HANDLER: widgets.onAction + raw event fallback ----
  const handleWidgetAction = useCallback(
    async (action: { type: string; payload?: any; id?: string }) => {
      // You’ll see this for every click
      console.info("[widgets.onAction]", action);

      // Map your four options (labels OR payloads) to messages you want to send
      const mapping: Record<string, string> = {
        "Case Studies": "Case Studies",
        "Slides Design": "Slides Design",
        "Meeting Prep": "Meeting Prep",
        "Research Help": "Research Help",
        case_studies: "Case Studies",
        slides_design: "Slides Design",
        meeting_prep: "Meeting Prep",
        research_help: "Research Help",
      };

      // Try to pick a message based on payload.text, payload.option, or action.type
      const guess =
        action?.payload?.text ??
        mapping[action?.payload?.option ?? ""] ??
        mapping[action?.type] ??
        null;

      if (!chatkit.control) {
        console.warn("No chatkit control yet; action ignored.");
        return { handled: false };
      }

      if (guess) {
        // Send as a user message so your router node sees it
        await chatkit.control.sendUserMessage({ text: guess });
        return { handled: true };
      }

      // Fallback: echo the raw action to the thread so you can inspect what’s coming through
      await chatkit.control.sendUserMessage({
        text: `Clicked: ${action.type} ${JSON.stringify(action.payload ?? {})}`,
      });
      return { handled: true };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Build ChatKit
  const chatkit = useChatKit({
    api: { getClientSecret },
    theme: { colorScheme: theme, ...getThemeConfig(theme) },
    startScreen: { greeting: GREETING, prompts: STARTER_PROMPTS },
    composer: { placeholder: PLACEHOLDER_INPUT, attachments: { enabled: true } },
    threadItemActions: { feedback: false },

    // 🔑 Register the widget action handler
    widgets: { onAction: handleWidgetAction },

    // existing client tools you already had
    onClientTool: async (invocation) => {
      if (invocation.name === "switch_theme") {
        const requested = invocation.params.theme;
        if (requested === "light" || requested === "dark") {
          if (isDev) console.debug("[ChatKitPanel] switch_theme", requested);
          onThemeRequest(requested);
          return { success: true };
        }
        return { success: false };
      }
      if (invocation.name === "record_fact") {
        const id = String(invocation.params.fact_id ?? "");
        const text = String(invocation.params.fact_text ?? "");
        if (!id || processedFacts.current.has(id)) return { success: true };
        processedFacts.current.add(id);
        void onWidgetAction({
          type: "save",
          factId: id,
          factText: text.replace(/\s+/g, " ").trim(),
        });
        return { success: true };
      }
      return { success: false };
    },
    onResponseStart: () => setErrorState({ integration: null, retryable: false }),
    onResponseEnd: () => onResponseEnd(),
    onThreadChange: () => processedFacts.current.clear(),
    onError: ({ error }) => console.error("ChatKit error", error),
  });

  // Raw DOM fallback (helps if your library version is old):
  useEffect(() => {
    if (!isBrowser) return;
    const fn = (e: any) => {
      const action = e?.detail;
      if (!action) return;
      console.info("[window chatkit-widget-action]", action);
      void handleWidgetAction(action);
    };
    window.addEventListener("chatkit-widget-action", fn as EventListener);
    return () => window.removeEventListener("chatkit-widget-action", fn as EventListener);
  }, [handleWidgetAction]);

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (isDev) {
    console.debug("[ChatKitPanel] render state", {
      isInitializingSession,
      hasControl: Boolean(chatkit.control),
      scriptStatus,
      hasError: Boolean(blockingError),
      workflowId: WORKFLOW_ID,
    });
  }

  return (
    <div className="relative pb-8 flex h-[90vh] w-full rounded-2xl flex-col overflow-hidden bg-white shadow-sm transition-colors dark:bg-slate-900">
      <ChatKit
        key={widgetInstanceKey}
        control={chatkit.control}
        className={blockingError || isInitializingSession ? "pointer-events-none opacity-0" : "block h-full w-full"}
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={blockingError || !isInitializingSession ? null : "Loading assistant session..."}
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
  if (typeof (payload as any).message === "string") return (payload as any).message;
  return fallback;
}

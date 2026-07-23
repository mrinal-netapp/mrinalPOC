import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { IconArrowUp, IconMessageCircle } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { AGENTS_STRINGS } from "../../../agents.consts";
import type {
  PlaygroundAgentActivity,
  PlaygroundChatMessage,
} from "../../agent-playground.types";
import type { PlaygroundModelLookup } from "../../agent-playground.utils";
import { AgentActivityStrip } from "../agent-activity-strip/agent-activity-strip";
import { PlaygroundChatAssistantContent } from "../playground-chat-assistant-content";
import { PlaygroundChatMessageMetadata } from "../playground-chat-message-metadata";
import "./playground-chat-panel.scss";

type PlaygroundChatPanelProps = {
  messages: PlaygroundChatMessage[];
  isLoading: boolean;
  onSendMessage: (message: string) => void;
  disabled?: boolean;
  emptyMessage?: string;
  outputDetailsVisible?: boolean;
  onToggleOutputDetails?: () => void;
  /** Extra action buttons to inject into the chat card header (used by the form workbench). */
  headerActions?: ReactNode[];
  /** Project models used to resolve gateway ids to registration display names. */
  modelLookup?: PlaygroundModelLookup[];
  /**
   * Live per-agent turn timeline for a team run (from the store's
   * `liveAgentActivity`). Rendered as a growing list inside the streaming
   * assistant message so the user sees which agent is running. Empty/omitted
   * for single-agent runs.
   */
  agentActivity?: PlaygroundAgentActivity[];
};

function PlaygroundChatPanel({
  messages,
  isLoading,
  onSendMessage,
  disabled = false,
  emptyMessage = "Ask a question to test your agent",
  outputDetailsVisible = false,
  onToggleOutputDetails,
  headerActions,
  modelLookup = [],
  agentActivity = [],
}: PlaygroundChatPanelProps): ReactElement {
  const [inputValue, setInputValue] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = inputValue.trim().length > 0 && !isLoading && !disabled;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || isLoading || disabled) {
      return;
    }
    onSendMessage(trimmed);
    setInputValue("");
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.style.height = "auto";
      }
    });
  }, [disabled, inputValue, isLoading, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Card className="agent-playground-chat">
      <CardHeader
        icon={<IconMessageCircle size={20} />}
        title="Chat"
        hasSeparator
        actions={
          headerActions
            ? headerActions
            : onToggleOutputDetails
              ? [
                <Button
                  key="toggle-output-details"
                  variant="outline"
                  size="small"
                  label={
                    outputDetailsVisible
                      ? AGENTS_STRINGS.HIDE_OUTPUT_DETAILS
                      : AGENTS_STRINGS.SHOW_OUTPUT_DETAILS
                  }
                  onClick={onToggleOutputDetails}
                />,
              ]
              : undefined
        }
      />

      <div ref={bodyRef} className="agent-playground-chat__body">
        {messages.length === 0 && (
          <div className="agent-playground-chat__empty">
            <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
              {emptyMessage}
            </Typography>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`agent-playground-chat__message agent-playground-chat__message--${message.role}`}
          >
            {message.role === "assistant" ? (
              <div className="agent-playground-chat__assistant">
                {/* Team run: show the live per-agent list (Hello → Time → …)
                    while streaming, so the user sees which agent is running. */}
                {message.isStreaming && agentActivity.length > 0 ? (
                  <AgentActivityStrip activity={agentActivity} />
                ) : null}
                {message.content ? (
                  <PlaygroundChatAssistantContent content={message.content} />
                ) : message.isStreaming && agentActivity.length === 0 ? (
                  // Single-agent run, or the pre-first-agent phase of a team
                  // run: show a spinner with a "Starting…" label so the user
                  // sees the run has begun rather than an unlabelled spinner.
                  <div className="agent-playground-chat__pending">
                    <Spinner size="cell" />
                    <Typography
                      Component="span"
                      fontSize="fs13"
                      color="var(--text-secondary)"
                    >
                      {AGENTS_STRINGS.CHAT_STARTING}
                    </Typography>
                  </div>
                ) : null}
                <PlaygroundChatMessageMetadata message={message} modelLookup={modelLookup} />
              </div>
            ) : (
              <Typography Component="p" fontSize="fs14">
                {message.content}
              </Typography>
            )}
          </div>
        ))}
      </div>

      <div className="agent-playground-chat__footer">
        <div className="agent-playground-chat__input-wrapper">
          <textarea
            ref={textareaRef}
            className="agent-playground-chat__textarea"
            placeholder="Ask anything..."
            value={inputValue}
            rows={1}
            disabled={isLoading || disabled}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="agent-playground-chat__send-btn">
            <Button
              variant="solid"
              size="medium"
              icon={<IconArrowUp size={18} />}
              aria-label="Send message"
              onClick={handleSend}
              isDisabled={!canSend}
              loading={isLoading}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

export { PlaygroundChatPanel };
export type { PlaygroundChatPanelProps };

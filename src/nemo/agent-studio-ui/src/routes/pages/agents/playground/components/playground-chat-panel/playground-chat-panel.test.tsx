import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AGENTS_STRINGS } from "../../../agents.consts";
import type { PlaygroundChatMessage } from "../../agent-playground.types";
import { PlaygroundChatPanel } from "./playground-chat-panel";

const defaultProps = {
  messages: [] as PlaygroundChatMessage[],
  isLoading: false,
  onSendMessage: vi.fn(),
};

describe("PlaygroundChatPanel", () => {
  it("[tag:agents] shows empty state with default and custom messages", () => {
    const { rerender } = render(<PlaygroundChatPanel {...defaultProps} />);

    expect(screen.getByText("Ask a question to test your agent")).toBeInTheDocument();

    rerender(
      <PlaygroundChatPanel {...defaultProps} emptyMessage="Custom empty prompt" />,
    );

    expect(screen.getByText("Custom empty prompt")).toBeInTheDocument();
  });

  it("[tag:agents] renders user and assistant messages", () => {
    render(
      <PlaygroundChatPanel
        {...defaultProps}
        messages={[
          { id: "user-1", role: "user", content: "Hello agent" },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Hello **user**",
            latencyMs: 120,
            modelName: "gpt-4o",
          },
        ]}
      />,
    );

    expect(screen.getByText("Hello agent")).toBeInTheDocument();
    expect(screen.getByText("user").tagName).toBe("STRONG");
    expect(screen.getByText(/Latency: 120 ms/)).toBeInTheDocument();
  });

  it("[tag:agents] shows spinner for streaming assistant placeholder", () => {
    render(
      <PlaygroundChatPanel
        {...defaultProps}
        messages={[
          { id: "assistant-1", role: "assistant", content: "", isStreaming: true },
        ]}
      />,
    );

    expect(document.querySelector(".agent-playground-chat__pending")).toBeInTheDocument();
  });

  it("[tag:agents] labels the pending spinner with 'Starting…' before any agent activity", () => {
    render(
      <PlaygroundChatPanel
        {...defaultProps}
        messages={[
          { id: "assistant-1", role: "assistant", content: "", isStreaming: true },
        ]}
        agentActivity={[]}
      />,
    );

    // The pre-first-agent phase shows a labelled spinner, not a bare one, so
    // the user sees the run has begun.
    expect(screen.getByText(AGENTS_STRINGS.CHAT_STARTING)).toBeInTheDocument();
    expect(document.querySelector(".agent-playground-chat__pending")).toBeInTheDocument();
  });

  it("[tag:agents] drops the 'Starting…' label once per-agent activity arrives", () => {
    render(
      <PlaygroundChatPanel
        {...defaultProps}
        messages={[{ id: "assistant-1", role: "assistant", content: "", isStreaming: true }]}
        agentActivity={[{ agentName: "Hello", status: "running" }]}
      />,
    );

    // Once agents report in, the activity strip replaces the "Starting…" spinner.
    expect(screen.queryByText(AGENTS_STRINGS.CHAT_STARTING)).not.toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("[tag:agents] shows the live per-agent activity list for a streaming team run", () => {
    render(
      <PlaygroundChatPanel
        {...defaultProps}
        messages={[{ id: "assistant-1", role: "assistant", content: "", isStreaming: true }]}
        agentActivity={[
          { agentName: "Hello", status: "completed", durationMs: 1834 },
          { agentName: "Time", status: "completed", durationMs: 1291 },
          { agentName: "random-num", status: "running" },
        ]}
      />,
    );

    // Each agent appears as its own row (a growing list), not a single spinner.
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("Time")).toBeInTheDocument();
    expect(screen.getByText("random-num")).toBeInTheDocument();
    // Completed turns show a duration; the active one shows "running…".
    expect(screen.getByText("1.8s")).toBeInTheDocument();
    expect(screen.getByText("running…")).toBeInTheDocument();
    // The team activity list replaces the plain thinking spinner.
    expect(document.querySelector(".agent-playground-chat__pending")).not.toBeInTheDocument();
  });

  it("[tag:agents] hides the agent activity list once the message finishes streaming", () => {
    render(
      <PlaygroundChatPanel
        {...defaultProps}
        messages={[
          { id: "assistant-1", role: "assistant", content: "final answer", isStreaming: false },
        ]}
        agentActivity={[{ agentName: "Hello", status: "completed", durationMs: 100 }]}
      />,
    );

    expect(screen.queryByLabelText("Team agent activity")).not.toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();
  });

  it("[tag:agents] sends message via button and Enter key", async () => {
    const onSendMessage = vi.fn();
    const user = userEvent.setup();

    render(<PlaygroundChatPanel {...defaultProps} onSendMessage={onSendMessage} />);

    const textarea = screen.getByPlaceholderText("Ask anything...");
    await user.type(textarea, "Test prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("Test prompt");
    expect(textarea).toHaveValue("");

    await user.type(textarea, "Another prompt");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSendMessage).toHaveBeenCalledWith("Another prompt");
  });

  it("[tag:agents] does not send when disabled, loading, or input is blank", async () => {
    const onSendMessage = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <PlaygroundChatPanel {...defaultProps} onSendMessage={onSendMessage} disabled />,
    );

    const textarea = screen.getByPlaceholderText("Ask anything...");
    await user.type(textarea, "Blocked");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).not.toHaveBeenCalled();

    rerender(<PlaygroundChatPanel {...defaultProps} onSendMessage={onSendMessage} isLoading />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).not.toHaveBeenCalled();

    rerender(<PlaygroundChatPanel {...defaultProps} onSendMessage={onSendMessage} />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("[tag:agents] toggles output details action label", async () => {
    const onToggleOutputDetails = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <PlaygroundChatPanel
        {...defaultProps}
        onToggleOutputDetails={onToggleOutputDetails}
        outputDetailsVisible={false}
      />,
    );

    const toggleButton = screen.getByRole("button", { name: AGENTS_STRINGS.SHOW_OUTPUT_DETAILS });
    await user.click(toggleButton);
    expect(onToggleOutputDetails).toHaveBeenCalledTimes(1);

    rerender(
      <PlaygroundChatPanel
        {...defaultProps}
        onToggleOutputDetails={onToggleOutputDetails}
        outputDetailsVisible
      />,
    );

    expect(screen.getByRole("button", { name: AGENTS_STRINGS.HIDE_OUTPUT_DETAILS })).toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { PlaygroundChatMessage } from "../../agent-playground.types";
import { PlaygroundChatMessageMetadata } from "./playground-chat-message-metadata";

const message: PlaygroundChatMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "Answer text",
  latencyMs: 255,
  modelName: "gpt-4o",
  usage: { totalTokens: 2190 },
  citations: [
    { source: "docs/performance-guide.md", knowledgeBaseName: "Product Docs", score: 0.9 },
    { source: "docs/troubleshooting.md", score: 0.8 },
  ],
};

describe("PlaygroundChatMessageMetadata", () => {
  it("[tag:agents] renders legend row and collapsible sources", async () => {
    const user = userEvent.setup();

    render(<PlaygroundChatMessageMetadata message={message} />);

    expect(screen.getByText(/Latency: 255 ms/)).toBeInTheDocument();
    expect(screen.getByText(/Total tokens: 2,190/)).toBeInTheDocument();
    expect(screen.getByText(/Model: GPT-4o/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sources \(2\)/ })).toBeInTheDocument();

    expect(screen.queryByText("performance-guide.md")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Sources \(2\)/ }));

    expect(screen.getByText("performance-guide.md")).toBeInTheDocument();
    expect(screen.getByText("troubleshooting.md")).toBeInTheDocument();
  });

  it("[tag:agents] returns null for user messages and renders citations-only metadata", async () => {
    const user = userEvent.setup();
    const { container: userContainer } = render(
      <PlaygroundChatMessageMetadata
        message={{ id: "user-1", role: "user", content: "Question" }}
      />,
    );
    expect(userContainer).toBeEmptyDOMElement();

    render(
      <PlaygroundChatMessageMetadata
        message={{
          id: "assistant-2",
          role: "assistant",
          content: "Answer",
          citations: [{ source: "docs/guide.md", score: 92, knowledgeBaseName: "Docs" }],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /Sources \(1\)/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sources \(1\)/ }));
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("Docs")).toBeInTheDocument();
  });

  it("[tag:agents] hides invalid citation scores and metadata for streaming messages", () => {
    const { container } = render(
      <PlaygroundChatMessageMetadata
        message={{
          id: "assistant-3",
          role: "assistant",
          content: "Answer",
          isStreaming: true,
          latencyMs: 10,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();

    render(
      <PlaygroundChatMessageMetadata
        message={{
          id: "assistant-4",
          role: "assistant",
          content: "Answer",
          citations: [{ source: "docs/a.md" }],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: /Sources \(1\)/ })).toBeInTheDocument();
  });
});

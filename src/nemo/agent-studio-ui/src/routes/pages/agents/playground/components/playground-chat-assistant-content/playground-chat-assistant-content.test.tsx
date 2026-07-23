import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlaygroundChatAssistantContent } from "./playground-chat-assistant-content";

describe("PlaygroundChatAssistantContent", () => {
  it("[tag:agents] renders plain text lines", () => {
    render(<PlaygroundChatAssistantContent content="Hello world" />);

    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("[tag:agents] renders bold markdown segments", () => {
    render(<PlaygroundChatAssistantContent content="Use **bold** text" />);

    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("[tag:agents] renders bullet lines and blank lines", () => {
    const { container } = render(
      <PlaygroundChatAssistantContent content={"Intro\n\n- First item\n- **Second** item"} />,
    );

    expect(screen.getByText(/Intro/)).toBeInTheDocument();
    expect(screen.getByText(/First item/)).toBeInTheDocument();
    expect(screen.getByText("Second").tagName).toBe("STRONG");
    expect(container.querySelector(".agent-playground-chat__assistant-line--bullet")).toBeInTheDocument();
    expect(container.querySelector("br")).toBeInTheDocument();
  });

  it("[tag:agents] pretty-prints a raw JSON object into a <pre> block", () => {
    const { container } = render(
      <PlaygroundChatAssistantContent content={'{"customerId":"c-1","amount":42}'} />,
    );

    const pre = container.querySelector(".agent-playground-chat__assistant-json");
    expect(pre?.tagName).toBe("PRE");
    // 2-space indented + newlines, not the collapsed one-liner.
    expect(pre?.textContent).toBe('{\n  "customerId": "c-1",\n  "amount": 42\n}');
  });

  it("[tag:agents] pretty-prints a fenced ```json block", () => {
    const content = '```json\n{"a":[1,2],"b":true}\n```';
    const { container } = render(<PlaygroundChatAssistantContent content={content} />);

    const pre = container.querySelector(".agent-playground-chat__assistant-json");
    expect(pre?.tagName).toBe("PRE");
    expect(pre?.textContent).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": true\n}');
  });

  it("[tag:agents] leaves non-JSON prose as plain text lines", () => {
    const { container } = render(
      <PlaygroundChatAssistantContent content="The result is {not valid json" />,
    );

    expect(container.querySelector(".agent-playground-chat__assistant-json")).not.toBeInTheDocument();
    expect(screen.getByText(/The result is/)).toBeInTheDocument();
  });

  it("[tag:agents] renders a fenced non-JSON code block verbatim in a <pre>", () => {
    const content = "```python\ndef add(a, b):\n    return a + b\n```";
    const { container } = render(<PlaygroundChatAssistantContent content={content} />);

    const pre = container.querySelector(".agent-playground-chat__assistant-code");
    expect(pre?.tagName).toBe("PRE");
    expect(pre?.textContent).toBe("def add(a, b):\n    return a + b");
    // Not misclassified as JSON.
    expect(container.querySelector(".agent-playground-chat__assistant-json")).not.toBeInTheDocument();
  });

  it("[tag:agents] renders inline `code` as a <code> element", () => {
    render(<PlaygroundChatAssistantContent content="Run `npm run dev` to start" />);

    const code = screen.getByText("npm run dev");
    expect(code.tagName).toBe("CODE");
  });

  it("[tag:agents] renders a fenced ```sql block verbatim in a <pre>", () => {
    const content = "```sql\nSELECT id, name\nFROM users\nWHERE active = true;\n```";
    const { container } = render(<PlaygroundChatAssistantContent content={content} />);

    const pre = container.querySelector(".agent-playground-chat__assistant-code");
    expect(pre?.tagName).toBe("PRE");
    expect(pre?.textContent).toBe("SELECT id, name\nFROM users\nWHERE active = true;");
    expect(container.querySelector(".agent-playground-chat__assistant-json")).not.toBeInTheDocument();
  });

  it("[tag:agents] handles prose mixed with a fenced code block", () => {
    const content = "Here is the script:\n```bash\nls -la\n```\nDone.";
    const { container } = render(<PlaygroundChatAssistantContent content={content} />);

    expect(screen.getByText(/Here is the script/)).toBeInTheDocument();
    const pre = container.querySelector(".agent-playground-chat__assistant-code");
    expect(pre?.textContent).toBe("ls -la");
    expect(screen.getByText(/Done\./)).toBeInTheDocument();
  });
});

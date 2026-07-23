import { Fragment, type ReactElement, type ReactNode } from "react";

/** A ``` fence line, optionally tagged with a language (```json, ```python). */
const FENCE_RE = /^```(\w*)\s*$/;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code"; code: string; isJson: boolean };

/**
 * Pretty-print `text` as JSON when it is a JSON object/array, else `null`.
 * The cheap first-char guard keeps ordinary prose out of the try/catch.
 */
function tryPrettyJson(text: string): string | null {
  const candidate = text.trim();
  const first = candidate[0];
  if (first !== "{" && first !== "[") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function makeCodeBlock(raw: string): ContentBlock {
  // Any fenced block whose body is JSON is pretty-printed (regardless of the
  // language tag); otherwise the code is preserved verbatim.
  const pretty = tryPrettyJson(raw);
  return pretty !== null
    ? { type: "code", code: pretty, isJson: true }
    : { type: "code", code: raw, isJson: false };
}

/**
 * Split assistant content into text and fenced-code blocks. Fenced ``` blocks
 * (any language) become code blocks; a code block whose body is JSON is
 * pretty-printed. A text segment that is *entirely* JSON (no fences) is also
 * promoted to a pretty-printed code block. Everything else stays text.
 */
function parseBlocks(content: string): ContentBlock[] {
  const lines = content.split("\n");
  const blocks: ContentBlock[] = [];
  let textBuf: string[] = [];
  let codeBuf: string[] = [];
  let inCode = false;

  const flushText = (): void => {
    const text = textBuf.join("\n");
    if (text.trim()) {
      blocks.push({ type: "text", text });
    }
    textBuf = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      if (inCode) {
        blocks.push(makeCodeBlock(codeBuf.join("\n")));
        inCode = false;
        codeBuf = [];
      } else {
        flushText();
        inCode = true;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
    } else {
      textBuf.push(line);
    }
  }

  // Unterminated fence: render what we collected as a code block anyway.
  if (inCode && codeBuf.join("\n").trim()) {
    blocks.push(makeCodeBlock(codeBuf.join("\n")));
  }
  flushText();

  // Promote a wholly-JSON text block (raw JSON, no fences) to a code block.
  return blocks.map((block) => {
    if (block.type === "text") {
      const pretty = tryPrettyJson(block.text);
      if (pretty !== null) {
        return { type: "code", code: pretty, isJson: true };
      }
    }
    return block;
  });
}

/** Inline markdown: `code` spans and **bold**, in that precedence. */
function renderInline(text: string): ReactNode[] {
  // Split on inline code first; odd indices are the code contents.
  const codeParts = text.split(/`([^`]+)`/g);
  const nodes: ReactNode[] = [];

  codeParts.forEach((part, ci) => {
    if (ci % 2 === 1) {
      nodes.push(
        <code key={`code-${ci}`} className="agent-playground-chat__assistant-inline-code">
          {part}
        </code>,
      );
      return;
    }
    if (!part) {
      return;
    }
    const boldParts = part.split(/\*\*(.+?)\*\*/g);
    boldParts.forEach((seg, bi) => {
      if (!seg) {
        return;
      }
      nodes.push(
        bi % 2 === 1 ? (
          <strong key={`b-${ci}-${bi}`}>{seg}</strong>
        ) : (
          <Fragment key={`t-${ci}-${bi}`}>{seg}</Fragment>
        ),
      );
    });
  });

  return nodes;
}

function TextBlock({ text, blockKey }: { text: string; blockKey: string }): ReactElement {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <br key={`${blockKey}-break-${index}`} />;
        }
        const isBullet = trimmed.startsWith("- ");
        const inner = isBullet ? trimmed.slice(2) : trimmed;
        return (
          <p
            key={`${blockKey}-line-${index}`}
            className={
              isBullet
                ? "agent-playground-chat__assistant-line agent-playground-chat__assistant-line--bullet"
                : "agent-playground-chat__assistant-line"
            }
          >
            {isBullet ? "• " : null}
            {renderInline(inner)}
          </p>
        );
      })}
    </>
  );
}

function PlaygroundChatAssistantContent({ content }: { content: string }): ReactElement {
  const blocks = parseBlocks(content);

  return (
    <div className="agent-playground-chat__assistant-content">
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre
            key={`code-${index}`}
            className={
              block.isJson
                ? "agent-playground-chat__assistant-json"
                : "agent-playground-chat__assistant-code"
            }
          >
            {block.code}
          </pre>
        ) : (
          <TextBlock key={`text-${index}`} text={block.text} blockKey={`text-${index}`} />
        ),
      )}
    </div>
  );
}

export { PlaygroundChatAssistantContent };

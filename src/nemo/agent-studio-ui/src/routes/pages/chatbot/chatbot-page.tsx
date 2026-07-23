import type { ReactElement } from "react";

const CHATBOT_URL =
  import.meta.env.VITE_CHATBOT_URL?.trim() || "/chatbot";

function ChatbotPage(): ReactElement {
  return (
    <iframe
      src={CHATBOT_URL}
      title="Chatbot"
      style={{
        border: 0,
        width: "100%",
        height: "100%",
        minHeight: "calc(100vh - 64px)",
      }}
    />
  );
}

export { ChatbotPage };

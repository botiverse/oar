import { noticeText, type SessionView, type ViewPart } from "../../packages/oar/src/browser.js";

function text(tag: string, value: string, className = ""): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  element.className = className;
  return element;
}

function partElement(part: ViewPart): HTMLElement {
  switch (part.kind) {
    case "text": return text("p", part.text);
    case "reasoning": return text("p", part.content.kind === "text" ? part.content.text : "Reasoning", "reasoning");
    case "tool": return text("pre", `${part.tool}: ${part.result}\n${part.output ?? ""}`);
    case "notice": return text("p", noticeText(part.notice), "notice");
    case "app_request": return text("p", `${part.type}: ${part.answered ? "answered" : "awaiting answer"}`, "notice");
  }
  throw new Error("Unknown view part");
}

/** All content is text, including model output. The demo never renders model-supplied HTML. */
export function renderView(view: SessionView, container: HTMLElement): void {
  const messages: HTMLElement[] = [];
  for (const message of view.messages) {
    const article = document.createElement("article");
    switch (message.kind) {
      case "input": article.append(text("h2", "You"), text("p", message.input.input)); break;
      case "notice": article.append(text("p", noticeText(message.notice), "notice")); break;
      case "turn":
        article.append(text("h2", "Assistant"));
        for (const section of message.sections) { article.append(...section.parts.map(partElement)); }
        if (message.outcome !== undefined) {
          const detail = message.outcome.kind === "failed" ? `: ${message.outcome.reason}` : "";
          article.append(text("p", `${message.outcome.kind}${detail}`, "outcome"));
        }
        break;
    }
    messages.push(article);
  }
  container.replaceChildren(...messages);
}

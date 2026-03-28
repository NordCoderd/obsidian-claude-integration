import { Notice } from "obsidian";

let container: HTMLElement | null = null;

export function initNoticeContainer(): void {
  container = document.createElement("div");
  container.className = "claude-notice-container";
  document.body.appendChild(container);
}

export function cleanupNoticeContainer(): void {
  container?.remove();
  container = null;
}

export function showNotice(message: string, duration?: number): Notice {
  const notice = new Notice(message, duration);
  container?.appendChild(notice.containerEl);
  return notice;
}

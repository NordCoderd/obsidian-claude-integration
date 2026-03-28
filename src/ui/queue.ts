import { EditorView, ViewPlugin } from "@codemirror/view";
import { App, setIcon } from "obsidian";
import { showNotice } from "./notice";
import * as path from "path";
import { ClaudeServer } from "../server";
import { PendingSelection } from "../types";

export class QueueManager {
  private app: App;
  private server: ClaudeServer;
  private getVaultPath: () => string;
  private onLoading: (loading: boolean) => void;
  private getShowInlineMenu: () => boolean;

  private pendingSelection: PendingSelection | null = null;
  private isSending: boolean = false;
  private activeEditorView: EditorView | null = null;
  private triggerBtnEl: HTMLElement | null = null;
  private promptBarEl: HTMLElement | null = null;
  private promptInputEl: HTMLInputElement | null = null;
  private lastSelectionCoords: { bottom: number; left: number; right: number } | null = null;
  private triggerLoadingInterval: number | null = null;
  private triggerLoadingFrame = 0;
  private triggerAnchorPos: number | null = null;

  constructor(
    app: App,
    server: ClaudeServer,
    getVaultPath: () => string,
    onLoading: (loading: boolean) => void,
    getShowInlineMenu: () => boolean,
  ) {
    this.app = app;
    this.server = server;
    this.getVaultPath = getVaultPath;
    this.onLoading = onLoading;
    this.getShowInlineMenu = getShowInlineMenu;
  }

  setup(): void {
    this.setupPromptBar();
  }

  cleanup(): void {
    this.stopTriggerLoadingAnimation();
    if (this.triggerBtnEl) {
      this.triggerBtnEl.remove();
      this.triggerBtnEl = null;
    }
    if (this.promptBarEl) {
      this.promptBarEl.remove();
      this.promptBarEl = null;
    }
  }

  buildSelectionExtension() {
    const repositionBtn = (view: EditorView) => {
      if (!this.triggerBtnEl?.classList.contains("is-visible")) return;
      const sel = view.state.selection.main;
      // During loading the selection may be cleared (e.g. user clicked Send with mouse),
      // so fall back to the captured anchor position.
      const pos = !sel.empty ? sel.to : this.triggerAnchorPos;
      if (pos === null) return;
      const coords = view.coordsAtPos(pos);
      if (coords) {
        this.triggerBtnEl.style.top = `${coords.top}px`;
        this.triggerBtnEl.style.left = `${coords.left + 4}px`;
      } else if (this.triggerLoadingInterval === null) {
        this.hideTriggerBtn();
      }
    };

    const scrollPlugin = ViewPlugin.fromClass(
      class {
        private handler: () => void;
        private scrollDOM: HTMLElement;
        constructor(view: EditorView) {
          this.scrollDOM = view.scrollDOM;
          this.handler = () => repositionBtn(view);
          this.scrollDOM.addEventListener("scroll", this.handler);
        }
        destroy() {
          this.scrollDOM.removeEventListener("scroll", this.handler);
        }
      }
    );

    return [
      scrollPlugin,
      EditorView.updateListener.of((update) => {
        this.activeEditorView = update.view;
        const sel = update.state.selection.main;
        if (!sel.empty) {
          this.captureCurrentSelection();
          if (this.getShowInlineMenu()) {
            const coords = update.view.coordsAtPos(sel.to);
            if (coords) {
              this.lastSelectionCoords = coords;
              this.showTriggerBtn(coords);
            } else {
              this.hideTriggerBtn();
            }
          } else {
            this.hideTriggerBtn();
          }
        } else {
          this.hideTriggerBtn();
          if (!this.isSending) {
            this.hidePromptBar();
          }
        }
      }),
    ];
  }

  hideBrainButton(): void {
    this.stopTriggerLoadingAnimation();
    this.triggerBtnEl?.classList.remove("is-visible");
  }

  hideQueueBar(): void {
    this.hidePromptBar();
  }

  openPromptBar(): void {
    if (!this.pendingSelection) {
      showNotice("Select text first, then use the hotkey.");
      return;
    }
    this.showPromptBar();
    this.promptInputEl?.focus();
  }

  updateQueueBarPosition(): void {
    if (!this.promptBarEl) return;

    const el = this.promptBarEl;
    const contentEl = this.activeEditorView?.contentDOM;
    if (contentEl) {
      const contentRect = contentEl.getBoundingClientRect();
      el.setCssStyles({
        width: `${contentRect.width}px`,
        minWidth: "unset",
        maxWidth: "unset",
        left: `${contentRect.left + contentRect.width / 2}px`,
      });
    } else {
      el.setCssStyles({
        width: "",
        minWidth: "",
        maxWidth: "",
        left: "50%",
      });
    }
    el.setCssStyles({ transform: "translateX(-50%)" });

    if (this.lastSelectionCoords) {
      const gap = 8;
      const barHeight = el.offsetHeight || 56;
      let top = this.lastSelectionCoords.bottom + gap;
      if (top + barHeight > window.innerHeight - 16) {
        top = this.lastSelectionCoords.bottom - barHeight - gap;
      }
      el.setCssStyles({ top: `${top}px`, bottom: "auto" });
    }
  }

  async runActionOnSelection(
    filePath: string,
    selection: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number },
    actionPrompt: string
  ): Promise<void> {
    const vaultPath = this.getVaultPath();
    this.startTriggerLoadingAnimation();
    this.onLoading(true);
    try {
      const prompt =
        `${actionPrompt}\n\nSelected text:\n${selection}\n\n` +
        `File path: ${path.join(vaultPath, filePath)}\n\n` +
        `Return ONLY the transformed text, no explanations, no code blocks.`;
      const result = await this.server.runClaudePrompt(prompt, vaultPath);
      await this.replaceSelectionInFile(filePath, from, to, result);
      this.stopTriggerLoadingAnimation();
      this.onLoading(false);
      showNotice("Claude: done!");
    } catch (err: unknown) {
      this.stopTriggerLoadingAnimation();
      this.onLoading(false);
      showNotice(`Claude error: ${err instanceof Error ? err.message : String(err)}`);
      console.error("Claude Code Sync: claude -p error", err);
    }
  }

  private showTriggerBtn(coords: { top: number; bottom: number; left: number; right: number }): void {
    if (this.triggerLoadingInterval !== null) return;
    if (!this.triggerBtnEl) {
      const btn = document.createElement("div");
      btn.className = "claude-trigger-btn";
      setIcon(btn, "message-circle");
      document.body.appendChild(btn);
      this.triggerBtnEl = btn;

      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        this.showPromptBar();
        this.promptInputEl?.focus();
      });
    }
    this.triggerBtnEl.style.top = `${coords.top}px`;
    this.triggerBtnEl.style.left = `${coords.left + 4}px`;
    this.triggerBtnEl.classList.add("is-visible");
  }

  private hideTriggerBtn(): void {
    if (this.triggerLoadingInterval !== null) return;
    this.triggerBtnEl?.classList.remove("is-visible");
  }

  private startTriggerLoadingAnimation(): void {
    if (!this.triggerBtnEl) return;
    // Capture current selection offset so scroll tracking works even after selection is cleared
    const view = this.activeEditorView;
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) this.triggerAnchorPos = sel.to;
    }
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.triggerLoadingFrame = 0;
    this.triggerBtnEl.classList.add("is-visible", "claude-trigger-btn--loading");
    this.triggerLoadingInterval = window.setInterval(() => {
      if (this.triggerBtnEl) {
        this.triggerBtnEl.textContent = frames[this.triggerLoadingFrame % frames.length];
        this.triggerLoadingFrame++;
      }
    }, 80);
  }

  private stopTriggerLoadingAnimation(): void {
    this.triggerAnchorPos = null;
    if (this.triggerLoadingInterval !== null) {
      window.clearInterval(this.triggerLoadingInterval);
      this.triggerLoadingInterval = null;
    }
    if (this.triggerBtnEl) {
      this.triggerBtnEl.classList.remove("is-visible", "claude-trigger-btn--loading");
      this.triggerBtnEl.textContent = "";
      setIcon(this.triggerBtnEl, "message-circle");
    }
  }

  private captureCurrentSelection(): void {
    const view = this.activeEditorView;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const text = view.state.sliceDoc(sel.from, sel.to);
    const fromLine = view.state.doc.lineAt(sel.from);
    const toLine = view.state.doc.lineAt(sel.to);

    this.pendingSelection = {
      text,
      filePath: file.path,
      from: { line: fromLine.number - 1, ch: sel.from - fromLine.from },
      to: { line: toLine.number - 1, ch: sel.to - toLine.from },
    };

    if (this.promptInputEl) {
      const preview = text.slice(0, 35).replace(/\n/g, " ");
      this.promptInputEl.placeholder = `Prompt for "${preview}${text.length > 35 ? "…" : ""}"`;
    }
  }

  private setupPromptBar(): void {
    const bar = document.createElement("div");
    bar.className = "claude-queue-bar";
    document.body.appendChild(bar);
    this.promptBarEl = bar;

    const controls = document.createElement("div");
    controls.className = "claude-queue-controls";
    bar.appendChild(controls);

    const input = document.createElement("input");
    input.className = "claude-queue-input";
    input.type = "text";
    input.placeholder = "Type a prompt…";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void this.sendPrompt(); }
      else if (e.key === "Escape") input.blur();
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!this.isSending && document.activeElement !== input) {
          this.hidePromptBar();
        }
      }, 150);
    });
    controls.appendChild(input);
    this.promptInputEl = input;

    const sendBtn = document.createElement("button");
    sendBtn.className = "claude-queue-btn claude-queue-run-btn";
    sendBtn.textContent = "Send ";
    const kbd = document.createElement("kbd");
    kbd.textContent = "↵";
    sendBtn.appendChild(kbd);
    sendBtn.addEventListener("click", () => { void this.sendPrompt(); });
    controls.appendChild(sendBtn);
  }

  private showPromptBar(): void {
    if (!this.promptBarEl) return;
    this.updateQueueBarPosition();
    this.promptBarEl.classList.add("is-visible");
  }

  private hidePromptBar(): void {
    this.promptBarEl?.classList.remove("is-visible");
  }

  private async sendPrompt(): Promise<void> {
    if (this.isSending) return;

    const promptText = this.promptInputEl?.value.trim();
    if (!promptText) {
      showNotice("Please type a prompt first.");
      return;
    }
    if (!this.pendingSelection) {
      showNotice("Please select text first, then click +.");
      return;
    }

    const selection = this.pendingSelection;
    this.pendingSelection = null;
    if (this.promptInputEl) {
      this.promptInputEl.value = "";
      this.promptInputEl.placeholder = "Type a prompt…";
    }

    this.isSending = true;
    this.hidePromptBar();
    this.startTriggerLoadingAnimation();
    this.onLoading(true);

    const vaultPath = this.getVaultPath();
    try {
      const prompt =
        `${promptText}\n\nSelected text:\n${selection.text}\n\n` +
        `File path: ${path.join(vaultPath, selection.filePath)}\n\n` +
        `Return ONLY the transformed text, no explanations, no code blocks.`;
      const result = await this.server.runClaudePrompt(prompt, vaultPath);
      await this.replaceSelectionInFile(selection.filePath, selection.from, selection.to, result);
      this.stopTriggerLoadingAnimation();
      this.onLoading(false);
      showNotice("Claude: done!");
    } catch (err: unknown) {
      this.stopTriggerLoadingAnimation();
      this.onLoading(false);
      showNotice(`Claude error: ${err instanceof Error ? err.message : String(err)}`);
      console.error("Claude Code Sync: sendPrompt error", err);
    }

    this.isSending = false;
  }

  private async replaceSelectionInFile(
    filePath: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number },
    newText: string
  ): Promise<void> {
    const file = this.app.vault.getFileByPath(filePath);
    if (!file) throw new Error(`File not found: ${filePath}`);

    const content = await this.app.vault.read(file);
    const fromOffset = this.lineChToOffset(content, from.line, from.ch);
    const toOffset = this.lineChToOffset(content, to.line, to.ch);

    const newContent = content.slice(0, fromOffset) + newText + content.slice(toOffset);
    await this.app.vault.modify(file, newContent);
  }

  private lineChToOffset(content: string, line: number, ch: number): number {
    let offset = 0;
    for (let i = 0; i < line; i++) {
      const nl = content.indexOf("\n", offset);
      if (nl === -1) return content.length;
      offset = nl + 1;
    }
    return offset + ch;
  }
}

import { FileView, Plugin, FileSystemAdapter } from "obsidian";

interface AppWithSetting {
  setting: {
    open(): void;
    openTabById(id: string): void;
  };
}
import * as path from "path";
import * as os from "os";
import { EditorView } from "@codemirror/view";
import { claudeHighlightField, setClaudeHighlight } from "./highlight";
import { ClaudeServer, toFileUrl } from "./server";
import { QueueManager } from "./ui/queue";
import { PluginSettings, DEFAULT_SETTINGS } from "./settings";
import { ClaudeSettingTab } from "./ui/settings-tab";
import { initNoticeContainer, cleanupNoticeContainer, showNotice } from "./ui/notice";

const LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default class ClaudeCodeSyncPlugin extends Plugin {
  server!: ClaudeServer;
  private queueManager!: QueueManager;
  private statusBarEl!: HTMLElement;
  settings!: PluginSettings;
  private lastBroadcastedSelection: string = "";
  private lastBroadcastedFile: string = "";
  private loadingInterval: number | null = null;
  private loadingTimeout: number | null = null;
  private loadingFrame = 0;

  async onload() {
    console.debug("Claude Code Sync: loading");

    await this.loadSettings();
    initNoticeContainer();

    this.server = new ClaudeServer(this.app, () => this.getVaultPath());
    this.queueManager = new QueueManager(
      this.app,
      this.server,
      () => this.getVaultPath(),
      (loading) => this.setLoading(loading),
      () => this.settings.showInlinePromptMenu,
    );

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("claude-status-bar");
    this.statusBarEl.addEventListener("click", () => this.openSettings());
    this.addSettingTab(new ClaudeSettingTab(this.app, this));

    if (!this.settings.claudeBinaryPath) {
      const found = this.server.findClaudeBinary();
      if (found) {
        this.settings.claudeBinaryPath = found;
        await this.saveSettings();
      }
    }

    this.applyBinaryPath();

    if (this.settings.claudeBinaryPath) {
      try {
        const version = await this.server.validateBinary(this.settings.claudeBinaryPath);
        console.debug(`Claude Code Sync: binary validated — ${version}`);
      } catch (err: unknown) {
        console.error("Claude Code Sync: binary validation failed", err);
        this.settings.claudeBinaryPath = "";
        await this.saveSettings();
        this.applyBinaryPath();
      }
    }

    await this.server.start();

    this.registerEditorExtension(claudeHighlightField);
    this.registerEditorExtension(this.queueManager.buildSelectionExtension());
    this.registerInterval(window.setInterval(() => this.pollAndBroadcast(), 100));

    this.queueManager.setup();

    this.addCommand({
      id: "open-prompt-bar",
      name: "Open prompt menu for selection",
      editorCallback: () => {
        this.queueManager.openPromptBar();
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (!selection) return;

        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        const from = editor.getCursor("from");
        const to = editor.getCursor("to");

        menu.addSeparator();

        for (const action of this.settings.actions.filter(a => a.title && a.prompt)) {
          menu.addItem((item) => {
            item
              .setTitle(action.title)
              .setIcon(action.icon)
              .onClick(() => {
                void this.queueManager.runActionOnSelection(file.path, selection, from, to, action.prompt);
              });
          });
        }

        menu.addSeparator();

        menu.addItem((item) => {
          item
            .setTitle("Claude integration settings")
            .setIcon("settings")
            .onClick(() => this.openSettings());
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.queueManager.updateQueueBarPosition())
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.queueManager.hideBrainButton();
        this.queueManager.hideQueueBar();
        this.queueManager.updateQueueBarPosition();
        const file = leaf?.view instanceof FileView ? leaf.view.file : null;
        if (file) {
          this.broadcastActiveFile(file.path);
        } else if (this.lastBroadcastedFile !== "") {
          const stillOpen = this.isFileOpen(this.lastBroadcastedFile);
          if (!stillOpen) {
            const absolutePath = path.join(this.getVaultPath(), this.lastBroadcastedFile);
            this.lastBroadcastedSelection = "";
            this.server.broadcast("selection_changed", {
              text: "",
              filePath: absolutePath,
              fileUrl: toFileUrl(absolutePath),
              selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
            });
          }
        }
      })
    );
  }

  onunload() {
    console.debug("Claude Code Sync: unloading");
    if (this.loadingInterval !== null) window.clearInterval(this.loadingInterval);
    if (this.loadingTimeout !== null) window.clearTimeout(this.loadingTimeout);
    this.server.stop();
    this.queueManager.cleanup();
    cleanupNoticeContainer();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>);
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      ...this.settings,
      actions: this.settings.actions.filter(a => a.title.trim() && a.prompt.trim()),
    });
  }

  openSettings(): void {
    const appWithSetting = this.app as unknown as AppWithSetting;
    appWithSetting.setting.open();
    appWithSetting.setting.openTabById(this.manifest.id);
  }

  applyBinaryPath(): void {
    this.server.setClaudeBinaryPath(this.settings.claudeBinaryPath);
    if (this.settings.claudeBinaryPath) {
      this.statusBarEl.setText("Claude 🟢");
    } else {
      this.statusBarEl.setText("Claude not found: click to configure");
      showNotice("Claude code not found. Set the path in settings.", 0);
    }
  }

  private setLoading(loading: boolean): void {
    if (loading) {
      if (this.loadingTimeout !== null) {
        window.clearTimeout(this.loadingTimeout);
        this.loadingTimeout = null;
      }
      this.loadingFrame = 0;
      this.loadingInterval = window.setInterval(() => {
        this.statusBarEl.setText(`Claude ${LOADING_FRAMES[this.loadingFrame % LOADING_FRAMES.length]}`);
        this.loadingFrame++;
      }, 80);
    } else {
      if (this.loadingInterval !== null) {
        window.clearInterval(this.loadingInterval);
        this.loadingInterval = null;
      }
      this.statusBarEl.setText("Claude ✅");
      this.loadingTimeout = window.setTimeout(() => {
        this.loadingTimeout = null;
        this.statusBarEl.setText("Claude 🟢");
      }, 2000);
    }
  }

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return os.homedir();
  }

  private isFileOpen(filePath: string): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof FileView && leaf.view.file?.path === filePath) found = true;
    });
    return found;
  }

  private broadcastActiveFile(filePath: string): void {
    console.debug(`Claude Code Sync: active-leaf-change → ${filePath}`);
    const absolutePath = path.join(this.getVaultPath(), filePath);
    this.lastBroadcastedFile = filePath;
    this.lastBroadcastedSelection = "";
    this.server.broadcast("selection_changed", {
      text: "",
      filePath: absolutePath,
      fileUrl: toFileUrl(absolutePath),
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
    });
  }

  private pollAndBroadcast(): void {
    const editor = this.app.workspace.activeEditor?.editor;
    const file = this.app.workspace.getActiveFile();

    if (!editor || !file) {
      if (this.lastBroadcastedFile !== "") {
        this.lastBroadcastedFile = "";
        this.lastBroadcastedSelection = "";
        this.server.broadcast("selection_changed", {
          text: "",
          filePath: null,
          fileUrl: null,
          selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
        });
      }
      return;
    }

    const selection = editor.getSelection();
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const vaultPath = this.getVaultPath();
    const absolutePath = path.join(vaultPath, file.path);

    const cmView = (editor as unknown as { cm?: EditorView }).cm;
    if (cmView) {
      if (selection.length > 0) {
        const fromOffset = cmView.state.doc.line(from.line + 1).from + from.ch;
        const toOffset = cmView.state.doc.line(to.line + 1).from + to.ch;
        cmView.dispatch({ effects: setClaudeHighlight.of({ from: fromOffset, to: toOffset }) });
      } else {
        cmView.dispatch({ effects: setClaudeHighlight.of(null) });
      }
    }

    if (selection === this.lastBroadcastedSelection && file.path === this.lastBroadcastedFile) return;
    this.lastBroadcastedSelection = selection;
    this.lastBroadcastedFile = file.path;

    if (!this.server.hasClients) return;

    this.server.broadcast("selection_changed", {
      text: selection,
      filePath: absolutePath,
      fileUrl: toFileUrl(absolutePath),
      selection: {
        start: { line: from.line, character: from.ch },
        end: { line: to.line, character: to.ch },
        isEmpty: selection.length === 0,
      },
    });
  }
}

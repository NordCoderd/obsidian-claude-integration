import { App, PluginSettingTab, Setting, TextComponent, setIcon } from "obsidian";
import { showNotice } from "./notice";
import type ClaudeCodeSyncPlugin from "../main";

interface AppWithSetting {
  setting: {
    open(): void;
    openTabById(id: string): void;
    activeTab: {
      searchComponent?: { setValue(v: string): void };
      updateHotkeyVisibility?(): void;
    } | null;
  };
}

interface ElectronWindow {
  electron: {
    remote: {
      dialog: {
        showOpenDialog(options: {
          properties: string[];
          title: string;
        }): Promise<{ canceled: boolean; filePaths: string[] }>;
      };
    };
  };
}

export class ClaudeSettingTab extends PluginSettingTab {
  private plugin: ClaudeCodeSyncPlugin;

  constructor(app: App, plugin: ClaudeCodeSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    this.plugin.settings.actions = this.plugin.settings.actions.filter(
      (a) => a.title.trim() && a.prompt.trim()
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Claude integration").setHeading();

    // ── Binary path ──────────────────────────────────────────────────────────

    let pathInput: TextComponent;

    new Setting(containerEl)
      .setName("Claude binary path")
      .setDesc("Path to the claude executable.")
      .addText((text) => {
        pathInput = text;
        text.inputEl.classList.add("claude-binary-input");
        text
          .setPlaceholder("e.g. /usr/local/bin/claude")
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value.trim();
            await this.plugin.saveSettings();
            this.plugin.applyBinaryPath();
          });
      })
      .addButton((btn) => {
        btn
          .setIcon("folder-open")
          .setTooltip("Browse for Claude CLI executable")
          .onClick(async () => {
            if (!("electron" in window)) {
              showNotice("File browser is only available in the desktop app.");
              return;
            }
            const result = await (window as unknown as ElectronWindow).electron.remote.dialog.showOpenDialog({
              properties: ["openFile"],
              title: "Select Claude CLI executable",
            });
            if (!result.canceled && result.filePaths.length > 0) {
              const chosen = result.filePaths[0];
              try {
                const version = await this.plugin.server.validateBinary(chosen);
                this.plugin.settings.claudeBinaryPath = chosen;
                await this.plugin.saveSettings();
                this.plugin.applyBinaryPath();
                pathInput.setValue(chosen);
                showNotice(`Claude validated: ${version}`);
              } catch (err: unknown) {
                showNotice(`Invalid binary: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Auto-detect")
          .setTooltip("Search for claude in known locations and envs")
          .onClick(async () => {
            const found = this.plugin.server.findClaudeBinary();
            if (found) {
              this.plugin.settings.claudeBinaryPath = found;
              await this.plugin.saveSettings();
              this.plugin.applyBinaryPath();
              pathInput.setValue(found);
              showNotice(`Claude found at: ${found}`);
            } else {
              showNotice("Claude CLI not found. Please install it or enter the path manually.");
            }
          });
      });

    // ── Hotkeys ──────────────────────────────────────────────────────────────

    new Setting(containerEl)
      .setName("Open inline prompt menu")
      .setDesc("Hotkey to open inline prompt menu for the selected text.")
      .addButton((btn) =>
        btn
          .setButtonText("Configure hotkey")
          .onClick(() => {
            const setting = (this.app as unknown as AppWithSetting).setting;
            setting.open();
            setting.openTabById("hotkeys");
            const tab = setting.activeTab;
            if (tab?.searchComponent) {
              tab.searchComponent.setValue("Open Claude prompt bar");
              tab.updateHotkeyVisibility?.();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show inline prompt menu")
      .setDesc("Display a chat button next to selected text to open the prompt bar.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showInlinePromptMenu)
          .onChange(async (value) => {
            this.plugin.settings.showInlinePromptMenu = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Editor menu actions ───────────────────────────────────────────────────

    const actionsHeading = containerEl.createDiv({ cls: "claude-actions-heading" });
    new Setting(actionsHeading).setName("Editor menu actions").setHeading();
    const addActionBtn = actionsHeading.createEl("button", { cls: "clickable-icon" });
    setIcon(addActionBtn, "circle-plus");
    addActionBtn.setAttribute("aria-label", "Add action");
    addActionBtn.addEventListener("click", () => {
      void (async () => {
        this.plugin.settings.actions.unshift({
          id: window.crypto.randomUUID(),
          title: "",
          icon: "sparkles",
          prompt: "",
        });
        await this.plugin.saveSettings();
        this.display();
      })();
    });

    containerEl.createEl("p", {
      text: "These actions appear in the right-click context menu when text is selected.",
      cls: "setting-item-description",
    });

    const actionList = containerEl.createDiv({ cls: "claude-action-list" });

    for (const action of this.plugin.settings.actions) {
      const card = actionList.createDiv({ cls: "claude-action-card" });

      const header = card.createDiv({ cls: "claude-action-header" });

      const nameInput = header.createEl("input");
      nameInput.type = "text";
      nameInput.className = "claude-action-name";
      nameInput.placeholder = "Action name…";
      nameInput.value = action.title;
      nameInput.addEventListener("input", () => {
        void (async () => {
          action.title = nameInput.value;
          await this.plugin.saveSettings();
        })();
      });

      const deleteBtn = header.createEl("button");
      deleteBtn.className = "claude-action-delete";
      deleteBtn.setAttribute("aria-label", "Remove action");
      setIcon(deleteBtn, "trash");
      deleteBtn.addEventListener("click", () => {
        void (async () => {
          this.plugin.settings.actions = this.plugin.settings.actions.filter(
            (a) => a.id !== action.id
          );
          await this.plugin.saveSettings();
          this.display();
        })();
      });

      const promptArea = card.createEl("textarea");
      promptArea.className = "claude-action-prompt";
      promptArea.placeholder = "Instruction sent to claude along with the selected text…";
      promptArea.value = action.prompt;
      promptArea.addEventListener("input", () => {
        void (async () => {
          action.prompt = promptArea.value;
          await this.plugin.saveSettings();
        })();
      });
    }
  }
}

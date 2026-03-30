import { App, FileView } from "obsidian";
import { showNotice } from "./ui/notice";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { TOOLS } from "./constants";
import { SelectionResult, OpenFile } from "./types";

export function toFileUrl(absolutePath: string): string {
  if (process.platform === "win32") {
    return "file:///" + absolutePath.replace(/\\/g, "/");
  }
  return "file://" + absolutePath;
}

function getClaudeIdeDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "claude")
      : path.join(os.homedir(), ".claude"));
  return path.join(configDir, "ide");
}

export class ClaudeServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private lockFilePath: string | null = null;
  private authToken: string = "";
  private _port: number = 0;
  private app: App;
  private getVaultPath: () => string;
  private _claudeBinaryPath: string = "";

  constructor(app: App, getVaultPath: () => string) {
    this.app = app;
    this.getVaultPath = getVaultPath;
  }

  setClaudeBinaryPath(p: string): void {
    this._claudeBinaryPath = p;
  }

  get port(): number { return this._port; }
  get hasClients(): boolean { return this.clients.size > 0; }

  async start(): Promise<void> {
    this.authToken = crypto.randomUUID() + "-" + crypto.randomUUID();

    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

      this.wss.on("connection", (ws: WebSocket, req) => {
        console.debug(`Claude Code Sync: client connected from ${req.socket.remoteAddress}`);
        this.clients.add(ws);

        ws.on("message", (data: Buffer) => {
          const raw = data.toString();
          console.debug("Claude Code Sync: ← received", raw);
          try {
            const msg = JSON.parse(raw) as { id: unknown; method: string; params: unknown };
            this.handleMessage(ws, msg);
          } catch (e) {
            console.error("Claude Code Sync: parse error", e);
          }
        });

        ws.on("close", (code, reason) => {
          console.debug(`Claude Code Sync: client disconnected (code=${code} reason=${String(reason)})`);
          this.clients.delete(ws);
        });

        ws.on("error", (err) => {
          console.error("Claude Code Sync: ws error", err);
          this.clients.delete(ws);
        });
      });

      this.wss.on("listening", () => {
        this._port = (this.wss!.address() as { port: number }).port;
        console.debug(`Claude Code Sync: MCP server listening on port ${this._port}`);
        this.writeLockFile();
        resolve();
      });

      this.wss.on("error", reject);
    });
  }

  stop(): void {
    if (this.lockFilePath) {
      try { fs.unlinkSync(this.lockFilePath); } catch { /* ignore */ }
      this.lockFilePath = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
  }

  broadcast(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  findClaudeBinary(): string | null {
    const isWin = process.platform === "win32";
    const home = os.homedir();
    const exts = isWin ? [".cmd", ".exe", ""] : [""];

    const knownPaths = isWin
      ? [
          path.join(home, "AppData", "Roaming", "npm", "claude.cmd"),
          path.join(home, "AppData", "Local", "npm", "claude.cmd"),
        ]
      : [
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          path.join(home, ".local/bin/claude"),
          path.join(home, ".npm-global/bin/claude"),
        ];

    for (const p of knownPaths) {
      if (fs.existsSync(p)) return p;
    }

    const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":");
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const full = path.join(dir, `claude${ext}`);
        if (fs.existsSync(full)) return full;
      }
    }

    return null;
  }

  isClaudeInstalled(): boolean {
    return this.findClaudeBinary() !== null;
  }

  validateBinary(binaryPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("Timeout: claude --version did not respond within 5s"));
      }, 5000);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim() || stderr.trim());
        else reject(new Error(`claude --version exited with code ${code}: ${stderr.slice(0, 200)}`));
      });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  runClaudePrompt(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const claudeBin = this._claudeBinaryPath;
      if (!claudeBin) { reject(new Error("Claude binary path not configured. Set it in Settings → Claude Code Sync.")); return; }
      const env = { ...process.env, CLAUDE_CODE_SSE_PORT: String(this._port) };
      // Pass prompt via stdin to avoid argument length limits and keep it out of the process list
      const proc = spawn(claudeBin, ["-p", "--allowedTools", "saveDocument"], {
        env,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      });
      proc.on("error", (err) => reject(err));
    });
  }

  private handleMessage(ws: WebSocket, msg: { id: unknown; method: string; params: unknown }): void {
    const { id, method, params } = msg;
    const p = params as Record<string, unknown> | undefined;

    if (method === "initialize") {
      const clientVersion = (p?.protocolVersion as string | undefined) ?? "2024-11-05";
      this.send(ws, id, {
        protocolVersion: clientVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "obsidian-claude-code-sync", version: "0.4.0" },
      });
      return;
    }

    if (method === "ide_connected") {
      console.debug(`Claude Code Sync: IDE connected, pid=${String(p?.pid)}`);
      const file = this.app.workspace.getActiveFile();
      if (file) {
        const absolutePath = path.join(this.getVaultPath(), file.path);
        const editor = this.app.workspace.activeEditor?.editor;
        const selection = editor?.getSelection() ?? "";
        const from = editor?.getCursor("from") ?? { line: 0, ch: 0 };
        const to = editor?.getCursor("to") ?? { line: 0, ch: 0 };
        this.broadcast("selection_changed", {
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
      return;
    }

    if (method === "notifications/initialized") return;
    if (method === "ping") { this.send(ws, id, {}); return; }

    if (method === "tools/list") {
      this.send(ws, id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      this.handleToolCall(ws, id, p?.name as string, (p?.arguments ?? {}) as Record<string, unknown>);
      return;
    }

    if (id !== undefined) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
    }
  }

  private handleToolCall(ws: WebSocket, id: unknown, toolName: string, args: Record<string, unknown>): void {
    switch (toolName) {
      case "getSelection": {
        const editor = this.app.workspace.activeEditor?.editor;
        const file = this.app.workspace.getActiveFile();
        const result: SelectionResult = {
          selection: editor?.getSelection() ?? "",
          file: file?.path ?? null,
          from: editor ? { line: editor.getCursor("from").line, ch: editor.getCursor("from").ch } : null,
          to: editor ? { line: editor.getCursor("to").line, ch: editor.getCursor("to").ch } : null,
          vaultPath: this.getVaultPath(),
        };
        this.send(ws, id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false });
        break;
      }

      case "getActiveFile": {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          this.send(ws, id, { content: [{ type: "text", text: "No active file" }], isError: true });
          return;
        }
        void this.app.vault.read(file).then((content) => {
          this.send(ws, id, { content: [{ type: "text", text: JSON.stringify({ path: file.path, content }, null, 2) }], isError: false });
        }).catch((err: unknown) => {
          this.send(ws, id, { content: [{ type: "text", text: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
        });
        break;
      }

      case "getOpenFiles": {
        const activeFile = this.app.workspace.getActiveFile();
        const openFiles: OpenFile[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof FileView && leaf.view.file) {
            openFiles.push({
              path: leaf.view.file.path,
              basename: leaf.view.file.basename,
              active: leaf.view.file.path === activeFile?.path,
            });
          }
        });
        this.send(ws, id, { content: [{ type: "text", text: JSON.stringify(openFiles, null, 2) }], isError: false });
        break;
      }

      case "openFile": {
        const notePath = this.requireString(ws, id, args, "path");
        if (notePath === null) return;
        const line = typeof args.line === "number" ? args.line : undefined;
        const file = this.app.vault.getFileByPath(notePath);
        if (!file) {
          this.send(ws, id, { content: [{ type: "text", text: `File not found: ${notePath}` }], isError: true });
          return;
        }
        void this.app.workspace.getLeaf(false).openFile(file).then(() => {
          if (line !== undefined) {
            const editor = this.app.workspace.activeEditor?.editor;
            if (editor) {
              editor.setCursor({ line, ch: 0 });
              editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
            }
          }
          this.send(ws, id, { content: [{ type: "text", text: `Opened: ${notePath}` }], isError: false });
        }).catch((err: unknown) => {
          this.send(ws, id, { content: [{ type: "text", text: `Failed to open file: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
        });
        break;
      }

      case "saveDocument": {
        const notePath = this.requireString(ws, id, args, "path");
        if (notePath === null) return;
        const content = this.requireString(ws, id, args, "content");
        if (content === null) return;
        const file = this.app.vault.getFileByPath(notePath);
        if (!file) {
          this.send(ws, id, { content: [{ type: "text", text: `File not found: ${notePath}` }], isError: true });
          return;
        }
        void this.app.vault.modify(file, content).then(() => {
          void this.app.workspace.getLeaf(false).openFile(file);
          showNotice(`Claude Code: saved ${file.basename}`);
          this.send(ws, id, { content: [{ type: "text", text: `Saved: ${notePath}` }], isError: false });
        }).catch((err: Error) => {
          this.send(ws, id, { content: [{ type: "text", text: `Failed to save: ${err.message}` }], isError: true });
        });
        break;
      }

      case "checkDocumentDirty": {
        const notePath = this.requireString(ws, id, args, "path");
        if (notePath === null) return;
        const file = this.app.vault.getFileByPath(notePath);
        if (!file) {
          this.send(ws, id, { content: [{ type: "text", text: `File not found: ${notePath}` }], isError: true });
          return;
        }
        this.send(ws, id, { content: [{ type: "text", text: JSON.stringify({ path: notePath, isDirty: false }) }], isError: false });
        break;
      }

      default:
        this.send(ws, id, { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true });
    }
  }

  private requireString(ws: WebSocket, id: unknown, args: Record<string, unknown>, key: string): string | null {
    const value = args[key];
    if (typeof value !== "string") {
      this.send(ws, id, { content: [{ type: "text", text: `Missing or invalid '${key}' argument` }], isError: true });
      return null;
    }
    return value;
  }

  private send(ws: WebSocket, id: unknown, result: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
    console.debug("Claude Code Sync: → sending", msg);
    ws.send(msg);
  }

  private writeLockFile(): void {
    const dir = getClaudeIdeDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.lockFilePath = path.join(dir, `${this._port}.lock`);
    const lockData = {
      pid: process.pid,
      workspaceFolders: [this.getVaultPath()],
      ideName: "Obsidian",
      transport: "ws",
      runningInWindows: process.platform === "win32",
      authToken: this.authToken,
    };
    fs.writeFileSync(this.lockFilePath, JSON.stringify(lockData), { mode: 0o600 });
    console.debug(`Claude Code Sync: lock file written → ${this.lockFilePath}`);
  }
}

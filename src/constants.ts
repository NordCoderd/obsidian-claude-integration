export const TOOLS = [
  {
    name: "getSelection",
    description: "Returns the currently selected text in Obsidian, along with the file path and cursor position.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getActiveFile",
    description: "Returns the full markdown content of the currently active note in Obsidian.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "getOpenFiles",
    description: "Returns a list of all open tabs in Obsidian.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openFile",
    description: "Opens a note in Obsidian by path. Optionally scrolls to a specific line.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path to the note, e.g. 'folder/note.md'" },
        line: { type: "number", description: "Optional line number to scroll to (0-indexed)" },
      },
      required: ["path"],
    },
  },
  {
    name: "saveDocument",
    description: "Writes new content to a note in Obsidian, replacing its entire content. The user can undo with Ctrl+Z.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path to the note, e.g. 'folder/note.md'" },
        content: { type: "string", description: "New full markdown content to write to the note" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "checkDocumentDirty",
    description: "Checks whether a note has unsaved changes in Obsidian.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path to the note" },
      },
      required: ["path"],
    },
  },
];

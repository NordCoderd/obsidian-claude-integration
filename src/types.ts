export interface SelectionResult {
  selection: string;
  file: string | null;
  from: { line: number; ch: number } | null;
  to: { line: number; ch: number } | null;
  vaultPath: string;
}

export interface OpenFile {
  path: string;
  basename: string;
  active: boolean;
}

export interface PendingSelection {
  text: string;
  filePath: string;
  from: { line: number; ch: number };
  to: { line: number; ch: number };
}

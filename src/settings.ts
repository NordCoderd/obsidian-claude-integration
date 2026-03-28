export interface CustomAction {
  id: string;
  title: string;
  icon: string;
  prompt: string;
}

export const DEFAULT_ACTIONS: CustomAction[] = [
  {
    id: "fix-grammar",
    title: "Fix Grammar",
    icon: "wand-2",
    prompt: "Fix grammar and spelling errors in the text below.",
  },
  {
    id: "improve-writing",
    title: "Improve Writing",
    icon: "pencil",
    prompt: "Improve the writing style and clarity of the text below. Keep the same meaning.",
  },
  {
    id: "make-shorter",
    title: "Make Shorter",
    icon: "minimize-2",
    prompt: "Shorten the text below while keeping the key meaning.",
  },
];

export interface PluginSettings {
  claudeBinaryPath: string;
  actions: CustomAction[];
  showInlinePromptMenu: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinaryPath: "",
  actions: DEFAULT_ACTIONS,
  showInlinePromptMenu: true,
};

import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

export const setClaudeHighlight = StateEffect.define<{ from: number; to: number } | null>();

export const claudeHighlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setClaudeHighlight)) {
        if (!effect.value) return Decoration.none;
        const { from, to } = effect.value;
        if (from === to) return Decoration.none;
        return Decoration.set([
          Decoration.mark({ class: "claude-selection-highlight" }).range(from, to),
        ]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

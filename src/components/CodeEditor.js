import { useEffect, useRef, h } from "../reactRuntime.js";
import { EditorState } from "https://esm.sh/@codemirror/state@6";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "https://esm.sh/@codemirror/view@6";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "https://esm.sh/@codemirror/commands@6";
import { javascript } from "https://esm.sh/@codemirror/lang-javascript@6";
import { python } from "https://esm.sh/@codemirror/lang-python@6";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6";

// CodeMirror 6 wrapped as a React component. It owns its own DOM, so we mount
// it once in a ref and forward changes up via `onChange`. The parent swaps
// problems or languages by remounting with a fresh `key` rather than
// reconfiguring the editor in place.
export default function CodeEditor({ initialCode, language, onChange }) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);

  useEffect(() => {
    const state = EditorState.create({
      doc: initialCode,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        language === "python" ? python() : javascript(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => view.destroy();
  }, []);

  return h("div", { className: "code-editor", ref: containerRef });
}

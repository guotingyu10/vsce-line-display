import * as vscode from 'vscode';

type OverlaySpec = {
  originLine: number;
  targetUri: vscode.Uri;
  startLine: number;
  endLine: number;
  show: boolean;
  opacity: number; // 0..1
  decorationType: vscode.TextEditorDecorationType | null;
  lines: string[];
};

const DIRECTIVE_REGEXES: RegExp[] = [
  /display\s+(\S+)\s+(\d+)\s*-\s*(\d+)\s*;\s*(\S+)/i,
  /display([^\s;]+?)(\d+)\s*-\s*(\d+)\s*;\s*(\S+)/i
];

const overlaysByEditor = new Map<vscode.TextEditor, OverlaySpec[]>();

export function activate(context: vscode.ExtensionContext) {
  const disposables: vscode.Disposable[] = [];

  const tryScan = async (editor?: vscode.TextEditor) => {
    if (!editor) return;
    const doc = editor.document;
    const text = doc.getText();
    const lines = text.split(/\r?\n/);
    
    const oldSpecs = overlaysByEditor.get(editor) || [];
    const newSpecs: OverlaySpec[] = [];
    
    // 1. Scan for all current directives
    for (let i = 0; i < lines.length; i++) {
      const match = matchDirective(lines[i]);
      if (!match) continue;
      const spec = createSpecFromMatch(match, editor, i);
      if (!spec) continue;
      newSpecs.push(spec);
    }

    // 2. Reconciliation: Reuse existing decoration types where possible
    // We match based on a signature key (ignoring originLine which can change on edit)
    const availableOldSpecs = [...oldSpecs];
    
    for (const newSpec of newSpecs) {
      const matchIndex = availableOldSpecs.findIndex(old => 
        old.targetUri.toString() === newSpec.targetUri.toString() &&
        old.startLine === newSpec.startLine &&
        old.endLine === newSpec.endLine &&
        old.show === newSpec.show &&
        old.opacity === newSpec.opacity
      );

      if (matchIndex !== -1) {
        // Found a match: reuse the decoration type and cached lines
        const reused = availableOldSpecs[matchIndex];
        newSpec.decorationType = reused.decorationType;
        newSpec.lines = reused.lines;
        
        // Remove from available list so we don't reuse it again for another identical directive
        availableOldSpecs.splice(matchIndex, 1);
      } else {
        // No match: this is a new or changed directive.
        // We need to load lines and create decoration type.
        await loadOverlayLines(newSpec);
        ensureDecorationType(newSpec);
      }
    }

    // 3. Dispose of any old specs that weren't reused
    for (const unused of availableOldSpecs) {
      unused.decorationType?.dispose();
    }

    // 4. Save new state and render
    overlaysByEditor.set(editor, newSpecs);
    
    // Render all new specs (reused ones need re-rendering because originLine might have changed)
    newSpecs.forEach(spec => {
      // If we reused a spec, decorationType is already set.
      // If it's new, we just called ensureDecorationType above.
      // Just double check in case something failed.
      if (!spec.decorationType) {
        ensureDecorationType(spec);
      }
      renderOverlay(editor, spec);
    });
  };

  // Debounce utility
  function debounce(func: Function, wait: number) {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: any[]) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        func(...args);
      }, wait);
    };
  }

  // Debounced version of tryScan
  const debouncedTryScan = debounce(tryScan, 300);

  const changeDocHandler = vscode.workspace.onDidChangeTextDocument((e) => {
    const editors = vscode.window.visibleTextEditors.filter(ed => ed.document === e.document);
    editors.forEach(editor => debouncedTryScan(editor));
  });
  disposables.push(changeDocHandler);

  const activeHandler = vscode.window.onDidChangeActiveTextEditor((editor) => {
    tryScan(editor ?? vscode.window.activeTextEditor);
  });
  disposables.push(activeHandler);

  const toggleCmd = vscode.commands.registerCommand('lineDisplay.toggle', () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const specs = overlaysByEditor.get(editor);
    if (!specs || specs.length === 0) return;
    for (const spec of specs) {
      spec.show = !spec.show;
      renderOverlay(editor, spec);
    }
  });
  disposables.push(toggleCmd);

  if (vscode.window.activeTextEditor) {
    tryScan(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(...disposables);
}

export function deactivate() {
  for (const [editor, specs] of overlaysByEditor.entries()) {
    for (const spec of specs) {
      spec.decorationType?.dispose();
    }
  }
  overlaysByEditor.clear();
}

function matchDirective(lineText: string): RegExpMatchArray | null {
  for (const rx of DIRECTIVE_REGEXES) {
    const m = lineText.match(rx);
    if (m) return m;
  }
  return null;
}

function createSpecFromMatch(
  match: RegExpMatchArray,
  editor: vscode.TextEditor,
  lineIndex: number
): OverlaySpec | null {
  const path = match[1];
  const startLine = parseInt(match[2], 10);
  const endLine = parseInt(match[3], 10);
  const paramsRaw = match[4] ?? '';
  const { show, opacity } = parseParams(paramsRaw);

  const targetUri = resolveTargetUri(editor.document.uri, path);
  if (!targetUri) return null;

  return {
    originLine: lineIndex,
    targetUri,
    startLine,
    endLine,
    show,
    opacity,
    decorationType: null,
    lines: []
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function parseParams(raw: string): { show: boolean; opacity: number } {
  let show = false;
  let opacity = 0.4;
  const s = raw.trim();
  if (!s) return { show, opacity };
  if (s.includes('.')) {
    const f = parseFloat(s);
    if (!isNaN(f)) opacity = clamp01(f);
    show = s.trim().startsWith('1');
    return { show, opacity };
  }
  let digits = s.replace(/\D+/g, '');
  if (!digits) return { show, opacity };
  if (digits[0] === '1') {
    show = true;
    digits = digits.slice(1);
  } else {
    show = false;
  }
  if (!digits) return { show, opacity };
  const n = parseInt(digits, 10);
  if (!isNaN(n)) {
    if (n > 1 && n <= 100) opacity = clamp01(n / 100);
    else opacity = clamp01(n);
  }
  return { show, opacity };
}

function resolveTargetUri(base: vscode.Uri, rawPath: string): vscode.Uri | null {
  const wsFolders = vscode.workspace.workspaceFolders;
  const isAbsolute = /^(?:[a-zA-Z]:\\|\/)/.test(rawPath);
  if (isAbsolute) return vscode.Uri.file(rawPath);
  if (wsFolders && wsFolders.length > 0) {
    return vscode.Uri.joinPath(wsFolders[0].uri, rawPath);
  }
  const dir = vscode.Uri.file(base.fsPath.replace(/[\\\/][^\\\/]+$/, ''));
  return vscode.Uri.joinPath(dir, rawPath);
}

async function loadOverlayLines(spec: OverlaySpec) {
  try {
    const doc = await vscode.workspace.openTextDocument(spec.targetUri);
    const lines: string[] = [];
    const startIdx = Math.max(0, spec.startLine - 1);
    const endIdx = Math.min(doc.lineCount - 1, spec.endLine - 1);
    for (let i = startIdx; i <= endIdx; i++) {
      lines.push(doc.lineAt(i).text);
    }
    spec.lines = lines;
  } catch {
    spec.lines = [];
  }
}

function ensureDecorationType(spec: OverlaySpec) {
  if (spec.decorationType) {
    spec.decorationType.dispose();
  }
  
  spec.decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
  });
}

function renderOverlay(editor: vscode.TextEditor, spec: OverlaySpec) {
  if (!spec.decorationType) return;
  if (!spec.show || spec.lines.length === 0) {
    editor.setDecorations(spec.decorationType, []);
    return;
  }

  const lineIdx = spec.originLine;
  if (lineIdx >= editor.document.lineCount) return;

  const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
  const decorations: vscode.DecorationOptions[] = [];

  for (let i = 0; i < spec.lines.length; i++) {
    const lineText = spec.lines[i];
    // Calculate top offset: (i + 1) * 1.5em (assuming line-height 1.5)
    // 1st line (i=0) -> 1.5em (below the anchor line)
    const topOffset = 1.5 * (i + 1);

    const css = `
      position: absolute;
      top: ${topOffset}em;
      left: 0;
      width: 100%;
      pointer-events: none;
      opacity: ${spec.opacity};
      line-height: 1.5;
      z-index: 10;
      color: var(--vscode-editorCodeLens-foreground);
      font-style: italic;
      white-space: pre;
    `;

    decorations.push({
      range,
      renderOptions: {
        after: {
          contentText: lineText,
          textDecoration: `none; ${css.replace(/\s+/g, ' ')}`
        }
      }
    });
  }

  editor.setDecorations(spec.decorationType, decorations);
}

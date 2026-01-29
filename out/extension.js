"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const DIRECTIVE_REGEXES = [
    /display\s+(\S+)\s+(\d+)\s*-\s*(\d+)\s*;\s*(\S+)/i,
    /display([^\s;]+?)(\d+)\s*-\s*(\d+)\s*;\s*(\S+)/i
];
const overlaysByEditor = new Map();
function activate(context) {
    const disposables = [];
    const tryScan = async (editor) => {
        if (!editor)
            return;
        const doc = editor.document;
        // Filter out irrelevant schemes (e.g. output, debug, git) to avoid unnecessary processing
        if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') {
            return;
        }
        // Performance safeguard: skip extremely large files (e.g. > 10MB or > 100k lines)
        // to prevent blocking the extension host with regex matching.
        if (doc.lineCount > 50000) {
            return;
        }
        const text = doc.getText();
        const lines = text.split(/\r?\n/);
        const oldSpecs = overlaysByEditor.get(editor) || [];
        const newSpecs = [];
        // 1. Scan for all current directives
        for (let i = 0; i < lines.length; i++) {
            const match = matchDirective(lines[i]);
            if (!match)
                continue;
            const spec = createSpecFromMatch(match, editor, i);
            if (!spec)
                continue;
            newSpecs.push(spec);
        }
        // 2. Reconciliation: Reuse existing decoration types where possible
        // We match based on a signature key (ignoring originLine which can change on edit)
        const availableOldSpecs = [...oldSpecs];
        for (const newSpec of newSpecs) {
            const matchIndex = availableOldSpecs.findIndex(old => old.targetUri.toString() === newSpec.targetUri.toString() &&
                old.startLine === newSpec.startLine &&
                old.endLine === newSpec.endLine &&
                old.show === newSpec.show &&
                old.opacity === newSpec.opacity &&
                old.indent === newSpec.indent);
            if (matchIndex !== -1) {
                // Found a match: reuse the decoration type and cached lines
                const reused = availableOldSpecs[matchIndex];
                newSpec.decorationType = reused.decorationType;
                newSpec.lines = reused.lines;
                // Remove from available list so we don't reuse it again for another identical directive
                availableOldSpecs.splice(matchIndex, 1);
            }
            else {
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
    function debounce(func, wait) {
        let timeout = null;
        return (...args) => {
            if (timeout)
                clearTimeout(timeout);
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
    const visibleHandler = vscode.window.onDidChangeVisibleTextEditors((visibleEditors) => {
        // 1. Clean up invisible editors
        const visibleSet = new Set(visibleEditors);
        for (const [editor, specs] of overlaysByEditor.entries()) {
            if (!visibleSet.has(editor)) {
                // Dispose decorations to free resources
                for (const spec of specs) {
                    spec.decorationType?.dispose();
                }
                // Remove from map to prevent memory leak
                overlaysByEditor.delete(editor);
            }
        }
        // 2. Scan newly visible editors
        for (const editor of visibleEditors) {
            if (!overlaysByEditor.has(editor)) {
                tryScan(editor);
            }
        }
    });
    disposables.push(visibleHandler);
    const toggleCmd = vscode.commands.registerCommand('lineDisplay.toggle', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const specs = overlaysByEditor.get(editor);
        if (!specs || specs.length === 0)
            return;
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
function deactivate() {
    for (const [editor, specs] of overlaysByEditor.entries()) {
        for (const spec of specs) {
            spec.decorationType?.dispose();
        }
    }
    overlaysByEditor.clear();
}
function matchDirective(lineText) {
    for (const rx of DIRECTIVE_REGEXES) {
        const m = lineText.match(rx);
        if (m)
            return m;
    }
    return null;
}
function createSpecFromMatch(match, editor, lineIndex) {
    const path = match[1];
    const startLine = parseInt(match[2], 10);
    const endLine = parseInt(match[3], 10);
    const paramsRaw = match[4] ?? '';
    const { show, opacity, indent } = parseParams(paramsRaw);
    const targetUri = resolveTargetUri(editor.document.uri, path);
    if (!targetUri)
        return null;
    return {
        originLine: lineIndex,
        targetUri,
        startLine,
        endLine,
        show,
        opacity,
        indent,
        decorationType: null,
        lines: []
    };
}
function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
function parseParams(raw) {
    let show = false;
    let opacity = 0.4;
    let indent = 0;
    const s = raw.trim();
    if (!s)
        return { show, opacity, indent };
    // Float parsing mode (e.g. "1; 0.5") - limited support for '3' indentation unless explicitly handled
    // For now, we assume users using '3' for indentation will use the compact integer format (e.g. "13320")
    if (s.includes('.')) {
        const f = parseFloat(s);
        if (!isNaN(f))
            opacity = clamp01(f);
        show = s.trim().startsWith('1');
        return { show, opacity, indent };
    }
    // Integer parsing mode
    let digits = s.replace(/\D+/g, '');
    if (!digits)
        return { show, opacity, indent };
    // 1. Check Show (first digit '1')
    if (digits[0] === '1') {
        show = true;
        digits = digits.slice(1);
    }
    else {
        show = false;
    }
    if (!digits)
        return { show, opacity, indent };
    // 2. Extract Indent ('3')
    // We count '3's and remove them from the string used for opacity
    let indentCount = 0;
    let cleanDigits = '';
    for (const char of digits) {
        if (char === '3') {
            indentCount++;
        }
        else {
            cleanDigits += char;
        }
    }
    indent = indentCount;
    digits = cleanDigits;
    // 3. Parse Opacity (remaining digits)
    if (!digits) {
        // If only '3's were present (e.g. "133"), we default opacity to 0.4
        // If user explicitly wants 0 opacity, they should provide '0' (e.g. "1330")
        return { show, opacity, indent };
    }
    const n = parseInt(digits, 10);
    if (!isNaN(n)) {
        if (n > 1 && n <= 100)
            opacity = clamp01(n / 100);
        else
            opacity = clamp01(n);
    }
    return { show, opacity, indent };
}
function resolveTargetUri(base, rawPath) {
    const isAbsolute = /^(?:[a-zA-Z]:\\|\/)/.test(rawPath);
    if (isAbsolute)
        return vscode.Uri.file(rawPath);
    // Always resolve relative to the current document's directory
    // This supports standard relative paths like "./foo.txt", "../foo.txt" or just "foo.txt"
    return vscode.Uri.joinPath(base, '..', rawPath);
}
async function loadOverlayLines(spec) {
    try {
        const doc = await vscode.workspace.openTextDocument(spec.targetUri);
        const lines = [];
        const startIdx = Math.max(0, spec.startLine - 1);
        const endIdx = Math.min(doc.lineCount - 1, spec.endLine - 1);
        for (let i = startIdx; i <= endIdx; i++) {
            lines.push(doc.lineAt(i).text);
        }
        spec.lines = lines;
    }
    catch (error) {
        console.error(`[LineDisplay] Failed to load overlay lines for ${spec.targetUri.toString()}:`, error);
        spec.lines = [];
    }
}
function ensureDecorationType(spec) {
    if (spec.decorationType) {
        spec.decorationType.dispose();
    }
    spec.decorationType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
    });
}
function renderOverlay(editor, spec) {
    if (!spec.decorationType)
        return;
    if (!spec.show || spec.lines.length === 0) {
        editor.setDecorations(spec.decorationType, []);
        return;
    }
    const lineIdx = spec.originLine;
    if (lineIdx >= editor.document.lineCount)
        return;
    const range = new vscode.Range(lineIdx, 0, lineIdx, 0);
    const decorations = [];
    for (let i = 0; i < spec.lines.length; i++) {
        const lineText = spec.lines[i];
        // Calculate top offset: (i + 1) * 1.5em (assuming line-height 1.5)
        // 1st line (i=0) -> 1.5em (below the anchor line)
        const topOffset = 1.5 * (i + 1);
        const css = `
      position: absolute;
      top: ${topOffset}em;
      left: 0;
      padding-left: ${spec.indent}ch;
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
//# sourceMappingURL=extension.js.map
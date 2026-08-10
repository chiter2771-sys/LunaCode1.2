import * as vscode from "vscode";
import { ContextBudgetManager, BudgetItem } from "../core/context/budget";
import { relativePath } from "../utils/workspace";
export class ContextManager {
  constructor(private readonly budget = new ContextBudgetManager()) {}
  async collectForPrompt(userText: string): Promise<string> {
    const items: BudgetItem[] = [];
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const doc = editor.document;
      items.push({ id: `current:${doc.uri.toString()}`, kind: "CurrentFile", priority: 90, text: `Current file: ${relativePath(doc.uri)}\nLanguage: ${doc.languageId}\n` });
      if (!editor.selection.isEmpty) items.push({ id: "selection", kind: "Selection", priority: 100, text: `Selection from ${relativePath(doc.uri)}:\n${doc.getText(editor.selection)}` });
    }
    for (const doc of vscode.workspace.textDocuments.filter((d) => !d.isUntitled).slice(0, 10)) items.push({ id: `open:${doc.uri.toString()}`, kind: "OpenFiles", priority: 40, text: `Open file: ${relativePath(doc.uri)}` });
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics().slice(0, 30)) if (diagnostics.length) items.push({ id: `diag:${uri.toString()}`, kind: "Diagnostics", priority: 70, text: diagnostics.slice(0, 10).map(d => `${relativePath(uri)}:${d.range.start.line+1} ${d.message}`).join("\n") });
    items.push({ id: "user", kind: "UserInstructions", priority: 100, text: userText });
    const result = this.budget.fit(items);
    return result.items.map(i => `### ${i.kind}\n${i.text}`).join("\n\n");
  }
}

import * as vscode from "vscode";
import { createDefaultToolRegistry } from "./tools/registry/defaultRegistry";
import { ConfirmFn } from "./core/tools/types";
import { safeResolveWorkspacePath } from "./utils/workspace";

export { ConfirmFn };

const previewContents = new Map<string, string>();
let previewCounter = 0;

export function registerDiffProvider(context: vscode.ExtensionContext) {
  const provider: vscode.TextDocumentContentProvider = { provideTextDocumentContent(uri) { return previewContents.get(uri.toString()) ?? ""; } };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("lunacode-preview", provider));
}

async function confirmWriteWithDiff(relPath: string, newContent: string): Promise<boolean> {
  const uri = safeResolveWorkspacePath(relPath);
  let isNew = false;
  try { await vscode.workspace.fs.stat(uri); } catch { isNew = true; }
  previewCounter++;
  const rightUri = vscode.Uri.parse(`lunacode-preview:/${encodeURIComponent(relPath)}?v=${previewCounter}`);
  previewContents.set(rightUri.toString(), newContent);
  const leftUri = isNew ? vscode.Uri.parse(`lunacode-preview:/${encodeURIComponent(relPath)}?empty=${previewCounter}`) : uri;
  if (isNew) previewContents.set(leftUri.toString(), "");
  try { await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, `LunaCode — предпросмотр: ${relPath}${isNew ? " (новый файл)" : ""}`); } catch { /* ignore */ }
  const choice = await vscode.window.showWarningMessage(`LunaCode wants to ${isNew ? "create" : "modify"}: ${relPath}`, { modal: true, detail: "Проверьте diff-вкладку перед подтверждением." }, "Allow", "Deny");
  previewContents.delete(rightUri.toString()); previewContents.delete(leftUri.toString());
  return choice === "Allow";
}

const registry = createDefaultToolRegistry(confirmWriteWithDiff);

export const TOOLS = registry.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

export async function executeTool(name: string, args: Record<string, any>, confirmFn: ConfirmFn, signal?: AbortSignal): Promise<string> {
  try { return await registry.execute(name, args, { confirm: confirmFn, signal }); } catch (err: any) { return `Ошибка выполнения инструмента "${name}": ${err?.message ?? err}`; }
}

export function getToolRegistry() { return registry; }

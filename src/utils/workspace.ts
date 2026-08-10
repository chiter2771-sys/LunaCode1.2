import * as vscode from "vscode";
import * as path from "path";
import { PermissionError } from "../core/errors/errors";
export function workspaceRoot(): vscode.Uri { const folders = vscode.workspace.workspaceFolders; if (!folders?.length) throw new Error("Нет открытой папки workspace."); return folders[0].uri; }
export function safeResolveWorkspacePath(relPath: string): vscode.Uri {
  const root = workspaceRoot(); const rootPath = path.resolve(root.fsPath); const input = String(relPath || ".").replace(/^[/\\]+/, ""); const target = path.resolve(rootPath, input);
  const allowed = target === rootPath || target.startsWith(rootPath + path.sep); if (!allowed) throw new PermissionError(`Путь выходит за пределы workspace: ${relPath}`);
  return vscode.Uri.file(target);
}
export function relativePath(uri: vscode.Uri): string { return path.relative(workspaceRoot().fsPath, uri.fsPath).replace(/\\/g, "/"); }
export function isProbablyBinary(bytes: Uint8Array): boolean { const len = Math.min(bytes.length, 8000); for (let i=0;i<len;i++) if (bytes[i] === 0) return true; return false; }

import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Определения инструментов в общем виде (конвертируются под формат
 * конкретного провайдера — Anthropic tools / OpenAI functions).
 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_directory",
    description:
      "Показать список файлов и папок по указанному относительному пути внутри открытого workspace. Путь '.' — корень проекта.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Относительный путь внутри workspace, например '.' или 'src'" }
      },
      required: ["path"]
    }
  },
  {
    name: "read_file",
    description: "Прочитать содержимое текстового файла по относительному пути внутри workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Относительный путь к файлу, например 'src/extension.ts'" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description:
      "Создать файл или перезаписать существующий указанным содержимым. Перед выполнением пользователю показывается diff (сравнение старого и нового содержимого) и запрашивается подтверждение.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Относительный путь к файлу" },
        content: { type: "string", description: "Полное новое содержимое файла" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "create_directory",
    description: "Создать новую папку (и промежуточные, если нужно) по относительному пути.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Относительный путь новой папки" }
      },
      required: ["path"]
    }
  },
  {
    name: "run_terminal_command",
    description:
      "Выполнить shell-команду (например 'npm test', 'npm install', 'git status') в корне открытого workspace. Требует подтверждения пользователя перед выполнением. Не используйте для интерактивных или долго висящих команд (таймаут 30 секунд).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Команда для выполнения в shell" }
      },
      required: ["command"]
    }
  }
];

function workspaceRoot(): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("Нет открытой папки workspace — откройте проект, чтобы агент мог работать с файлами.");
  }
  return folders[0].uri;
}

function resolvePath(relPath: string): vscode.Uri {
  const root = workspaceRoot();
  const clean = (relPath || ".").replace(/^\/+/, "");
  return clean === "." ? root : vscode.Uri.joinPath(root, clean);
}

export type ConfirmFn = (message: string, detail?: string) => Promise<boolean>;

/* ------------------------------------------------------------------ */
/*  DIFF-ПРЕДПРОСМОТР перед записью файла                              */
/* ------------------------------------------------------------------ */

const previewContents = new Map<string, string>();
let previewCounter = 0;

/**
 * Регистрирует виртуальную файловую систему "lunacode-preview", через
 * которую diff-редактор VS Code может отобразить предлагаемое агентом
 * содержимое файла ещё до того, как оно реально записано на диск.
 * Вызывается один раз из activate().
 */
export function registerDiffProvider(context: vscode.ExtensionContext) {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri) {
      return previewContents.get(uri.toString()) ?? "";
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("lunacode-preview", provider)
  );
}

/**
 * Открывает diff-вкладку (старое содержимое ↔ предложенное агентом) и
 * запрашивает у пользователя модальное подтверждение записи.
 */
async function confirmWriteWithDiff(relPath: string, newContent: string): Promise<boolean> {
  const uri = resolvePath(relPath);
  let existing = "";
  let isNew = false;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    existing = Buffer.from(bytes).toString("utf-8");
  } catch {
    isNew = true;
  }

  previewCounter++;
  const rightUri = vscode.Uri.parse(`lunacode-preview:/${relPath}?v=${previewCounter}`);
  previewContents.set(rightUri.toString(), newContent);

  let leftUri: vscode.Uri;
  if (isNew) {
    const leftEmptyUri = vscode.Uri.parse(`lunacode-preview:/${relPath}?empty=${previewCounter}`);
    previewContents.set(leftEmptyUri.toString(), "");
    leftUri = leftEmptyUri;
  } else {
    leftUri = uri;
  }

  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `LunaCode — предпросмотр: ${relPath}${isNew ? " (новый файл)" : ""}`
    );
  } catch {
    /* если diff не открылся — всё равно продолжаем к подтверждению */
  }

  const choice = await vscode.window.showWarningMessage(
    `ИИ-агент хочет ${isNew ? "создать" : "перезаписать"} файл: ${relPath}`,
    {
      modal: true,
      detail: "Проверьте вкладку с diff, которая только что открылась, прежде чем разрешить запись."
    },
    "Разрешить"
  );

  previewContents.delete(rightUri.toString());
  if (isNew) previewContents.delete(`lunacode-preview:/${relPath}?empty=${previewCounter}`);

  return choice === "Разрешить";
}

/* ------------------------------------------------------------------ */
/*  ВЫПОЛНЕНИЕ ИНСТРУМЕНТОВ                                            */
/* ------------------------------------------------------------------ */

/**
 * Выполняет вызов инструмента по имени и аргументам, возвращает текстовый
 * результат, который отправляется обратно модели как tool_result.
 * Опасные операции (запись файла, создание папки, выполнение команды)
 * требуют подтверждения пользователя.
 */
export async function executeTool(
  name: string,
  args: Record<string, any>,
  confirmFn: ConfirmFn
): Promise<string> {
  try {
    switch (name) {
      case "list_directory": {
        const uri = resolvePath(args.path ?? ".");
        const entries = await vscode.workspace.fs.readDirectory(uri);
        if (entries.length === 0) return "(папка пуста)";
        return entries
          .map(([n, type]) => `${type === vscode.FileType.Directory ? "[dir]" : "[file]"} ${n}`)
          .join("\n");
      }

      case "read_file": {
        const uri = resolvePath(args.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString("utf-8");
        // Ограничиваем размер, чтобы не раздувать контекст модели.
        return text.length > 20000 ? text.slice(0, 20000) + "\n...(обрезано)" : text;
      }

      case "write_file": {
        const ok = await confirmWriteWithDiff(args.path, String(args.content ?? ""));
        if (!ok) return "Пользователь отклонил запись файла.";
        const uri = resolvePath(args.path);
        const dir = vscode.Uri.joinPath(uri, "..");
        try {
          await vscode.workspace.fs.createDirectory(dir);
        } catch {
          /* уже существует */
        }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(String(args.content ?? ""), "utf-8"));
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          vscode.window.showTextDocument(doc, { preview: false });
        } catch {
          /* игнорируем ошибки открытия */
        }
        return `Файл записан: ${args.path}`;
      }

      case "create_directory": {
        const ok = await confirmFn(`ИИ-агент хочет создать папку: ${args.path}`);
        if (!ok) return "Пользователь отклонил создание папки.";
        const uri = resolvePath(args.path);
        await vscode.workspace.fs.createDirectory(uri);
        return `Папка создана: ${args.path}`;
      }

      case "run_terminal_command": {
        const command = String(args.command ?? "");
        const ok = await confirmFn(
          "ИИ-агент хочет выполнить команду в терминале:",
          command
        );
        if (!ok) return "Пользователь отклонил выполнение команды.";

        const root = workspaceRoot();
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: root.fsPath,
            timeout: 30000,
            maxBuffer: 1024 * 1024
          });
          let out = "";
          if (stdout?.trim()) out += `STDOUT:\n${stdout.trim()}`;
          if (stderr?.trim()) out += `${out ? "\n" : ""}STDERR:\n${stderr.trim()}`;
          if (!out) out = "(команда выполнена успешно, вывод пуст)";
          return out.length > 5000 ? out.slice(0, 5000) + "\n...(обрезано)" : out;
        } catch (err: any) {
          const stdout = err?.stdout ? `\nSTDOUT:\n${err.stdout}` : "";
          const stderr = err?.stderr ? `\nSTDERR:\n${err.stderr}` : "";
          return `Команда завершилась с ошибкой: ${err?.message ?? err}${stdout}${stderr}`;
        }
      }

      default:
        return `Неизвестный инструмент: ${name}`;
    }
  } catch (err: any) {
    return `Ошибка выполнения инструмента "${name}": ${err?.message ?? err}`;
  }
}

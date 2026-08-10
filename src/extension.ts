import * as vscode from "vscode";
import { LunaCodeChatViewProvider } from "./chatViewProvider";
import { checkHHChatBalance, HHCHAT_MODELS } from "./aiClient";
import { registerDiffProvider } from "./tools";

let lunaTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {
  registerDiffProvider(context);

  const chatProvider = new LunaCodeChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LunaCodeChatViewProvider.viewType,
      chatProvider
    )
  );

  // Требование: "Терминал как у VS Code" — используем нативный интегрированный
  // терминал VS Code, но открываем/переиспользуем его именованным под LunaCode.
  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.openTerminal", () => {
      if (!lunaTerminal || lunaTerminal.exitStatus !== undefined) {
        lunaTerminal = vscode.window.createTerminal("LunaCode Terminal");
      }
      lunaTerminal.show();
    })
  );

  // Требование: "структура папок/файлов как у VS Code" — используем нативный
  // Explorer VS Code (уже полностью реализован) и добавляем удобные команды
  // создания файлов/папок прямо из контекстного меню проводника.
  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.newFile", async (uri?: vscode.Uri) => {
      const folder = await resolveTargetFolder(uri);
      if (!folder) return;
      const name = await vscode.window.showInputBox({ prompt: "Имя нового файла" });
      if (!name) return;
      const fileUri = vscode.Uri.joinPath(folder, name);
      await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
      const doc = await vscode.workspace.openTextDocument(fileUri);
      vscode.window.showTextDocument(doc);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.newFolder", async (uri?: vscode.Uri) => {
      const folder = await resolveTargetFolder(uri);
      if (!folder) return;
      const name = await vscode.window.showInputBox({ prompt: "Имя новой папки" });
      if (!name) return;
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder, name));
    })
  );

  // Требование: "гибкая настройка доступа для подключения ИИ агента" —
  // ключ хранится в защищённом SecretStorage VS Code, отдельно на провайдера.
  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.setApiKey", async () => {
      const cfg = vscode.workspace.getConfiguration("lunacode");
      const provider = cfg.get<string>("provider", "anthropic");
      const key = await vscode.window.showInputBox({
        prompt: `API-ключ для провайдера "${provider}"`,
        password: true,
        ignoreFocusOut: true
      });
      if (key === undefined) return;
      await context.secrets.store(`lunacode.apiKey.${provider}`, key);
      vscode.window.showInformationMessage(`LunaCode: ключ для "${provider}" сохранён.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.clearChat", () => {
      chatProvider.clearHistory();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.openSettings", () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "lunacode"
      );
    })
  );

  // Проверка баланса токенов на шлюзе HHChat Pro (хhat.xyz) — берёт ключ,
  // сохранённый для провайдера "hhchat", и опрашивает /v1/token-balance.
  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.checkHHChatBalance", async () => {
      const apiKey = await context.secrets.get("lunacode.apiKey.hhchat");
      if (!apiKey) {
        vscode.window.showWarningMessage(
          'Сначала укажите API-ключ для провайдера "hhchat" через команду "LunaCode: Указать API-ключ ИИ-агента".'
        );
        return;
      }
      try {
        const result = await checkHHChatBalance(apiKey);
        const doc = await vscode.workspace.openTextDocument({
          content: result,
          language: "json"
        });
        vscode.window.showTextDocument(doc, { preview: true });
      } catch (err: any) {
        vscode.window.showErrorMessage(`LunaCode: ${err?.message ?? err}`);
      }
    })
  );

  // Быстрый выбор модели: для провайдера "hhchat" предлагает готовый список
  // моделей из их каталога, для остальных — просит ввести ID вручную.
  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.selectModel", async () => {
      const cfg = vscode.workspace.getConfiguration("lunacode");
      const provider = cfg.get<string>("provider", "anthropic");

      let modelId: string | undefined;
      if (provider === "hhchat") {
        modelId = await vscode.window.showQuickPick(HHCHAT_MODELS, {
          placeHolder: "Выберите модель HHChat Pro"
        });
      } else {
        modelId = await vscode.window.showInputBox({
          prompt: `ID модели для провайдера "${provider}"`,
          value: cfg.get<string>("model", "")
        });
      }

      if (!modelId) return;
      await cfg.update("model", modelId, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`LunaCode: модель установлена — ${modelId}`);
    })
  );

  // Отправить выделенный в редакторе код в чат LunaCode (Требование: кнопка
  // «отправить выделение»). Код подставляется в поле ввода как code-block,
  // пользователь может дописать вопрос и отправить.
  context.subscriptions.push(
    vscode.commands.registerCommand("lunacode.sendSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage("Сначала выделите код в редакторе.");
        return;
      }
      const code = editor.document.getText(editor.selection);
      const languageId = editor.document.languageId;
      await vscode.commands.executeCommand("lunacode.chatView.focus");
      chatProvider.prefillFromSelection(code, languageId);
    })
  );
}

async function resolveTargetFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri) {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory ? uri : vscode.Uri.joinPath(uri, "..");
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage("Откройте папку проекта в LunaCode, чтобы создавать файлы.");
    return undefined;
  }
  return folders[0].uri;
}

export function deactivate() {
  lunaTerminal?.dispose();
}

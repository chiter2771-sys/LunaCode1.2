import * as vscode from "vscode";
import {
  ChatMessage,
  getConfig,
  streamChatMessage,
  runAgentTurn,
  AgentStepEvent,
  UsageInfo,
  getPricingConfig,
  estimateCost
} from "./aiClient";
import { ConfirmFn } from "./tools";

const HISTORY_KEY = "lunacode.chatHistory";
const AGENT_MODE_KEY = "lunacode.agentMode";
const USAGE_KEY = "lunacode.usageTotals";

export class LunaCodeChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lunacode.chatView";

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private agentMode = false;
  private totalUsage: UsageInfo = { inputTokens: 0, outputTokens: 0, estimated: false };
  private configListenerRegistered = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.history = this.loadHistory();
    const store = vscode.workspace.workspaceFolders
      ? this.context.workspaceState
      : this.context.globalState;
    this.agentMode = store.get<boolean>(AGENT_MODE_KEY, false);
    this.totalUsage = store.get<UsageInfo>(USAGE_KEY, {
      inputTokens: 0,
      outputTokens: 0,
      estimated: false
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    // Восстанавливаем сохранённую историю в UI при открытии панели.
    for (const m of this.history) {
      this.post({
        type: m.role === "user" ? "userMessage" : "assistantMessage",
        text: m.content
      });
    }
    this.post({ type: "initAgentMode", value: this.agentMode });
    this.postUsageUpdate();
    this.postModelInfo();

    if (!this.configListenerRegistered) {
      this.configListenerRegistered = true;
      this.context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (
            e.affectsConfiguration("lunacode.model") ||
            e.affectsConfiguration("lunacode.provider") ||
            e.affectsConfiguration("lunacode.pricePerMillionInputTokens") ||
            e.affectsConfiguration("lunacode.pricePerMillionOutputTokens")
          ) {
            this.postModelInfo();
            this.postUsageUpdate();
          }
        })
      );
    }

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "send":
          await this.handleSend(msg.text as string);
          break;
        case "clear":
          this.history = [];
          await this.saveHistory();
          this.post({ type: "cleared" });
          break;
        case "resetUsage":
          this.totalUsage = { inputTokens: 0, outputTokens: 0, estimated: false };
          await this.saveUsage();
          this.postUsageUpdate();
          break;
        case "openTerminal":
          vscode.commands.executeCommand("lunacode.openTerminal");
          break;
        case "selectModel":
          vscode.commands.executeCommand("lunacode.selectModel");
          break;
        case "insertToEditor": {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            editor.edit((edit) => edit.insert(editor.selection.active, msg.text as string));
          } else {
            vscode.window.showInformationMessage("Нет открытого файла для вставки.");
          }
          break;
        }
        case "setAgentMode": {
          this.agentMode = !!msg.value;
          const store = vscode.workspace.workspaceFolders
            ? this.context.workspaceState
            : this.context.globalState;
          await store.update(AGENT_MODE_KEY, this.agentMode);
          break;
        }
      }
    });
  }

  public clearHistory() {
    this.history = [];
    this.saveHistory();
    this.post({ type: "cleared" });
  }

  /**
   * Принимает выделенный в редакторе код и подставляет его в поле ввода
   * чата (не отправляя сразу — пользователь может дописать вопрос).
   */
  public prefillFromSelection(code: string, languageId: string) {
    this.post({ type: "prefill", text: `\`\`\`${languageId}\n${code}\n\`\`\`\n\n` });
  }

  private loadHistory(): ChatMessage[] {
    const store = vscode.workspace.workspaceFolders
      ? this.context.workspaceState
      : this.context.globalState;
    return store.get<ChatMessage[]>(HISTORY_KEY, []);
  }

  private async saveHistory() {
    const store = vscode.workspace.workspaceFolders
      ? this.context.workspaceState
      : this.context.globalState;
    const trimmed = this.history.slice(-60);
    await store.update(HISTORY_KEY, trimmed);
  }

  private async saveUsage() {
    const store = vscode.workspace.workspaceFolders
      ? this.context.workspaceState
      : this.context.globalState;
    await store.update(USAGE_KEY, this.totalUsage);
  }

  private postUsageUpdate(last?: UsageInfo) {
    const pricing = getPricingConfig();
    const totalCost = estimateCost(this.totalUsage, pricing);
    const lastCost = last ? estimateCost(last, pricing) : undefined;
    this.post({
      type: "usageUpdate",
      total: this.totalUsage,
      last,
      totalCost,
      lastCost,
      showCost: pricing.pricePerMillionInput > 0 || pricing.pricePerMillionOutput > 0
    });
  }

  private postModelInfo() {
    const cfg = vscode.workspace.getConfiguration("lunacode");
    this.post({
      type: "modelInfo",
      provider: cfg.get<string>("provider", "anthropic"),
      model: cfg.get<string>("model", "")
    });
  }

  private async handleSend(text: string) {
    if (!text?.trim()) return;
    this.history.push({ role: "user", content: text });
    await this.saveHistory();
    this.post({ type: "userMessage", text });

    try {
      const config = await getConfig(this.context);

      if (this.agentMode) {
        this.post({ type: "assistantTyping" });
        const confirmFn: ConfirmFn = async (message, detail) => {
          const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true, detail: detail ?? "" },
            "Разрешить"
          );
          return choice === "Разрешить";
        };
        const onStep = (evt: AgentStepEvent) => {
          if (evt.type === "tool-call") {
            this.post({ type: "agentStep", text: `🔧 Вызов инструмента: ${evt.tool}(${JSON.stringify(evt.args)})` });
          } else if (evt.type === "tool-result") {
            this.post({ type: "agentStep", text: `↳ Результат: ${truncate(evt.text ?? "", 300)}` });
          }
        };
        const { text: reply, usage } = await runAgentTurn(config, this.history, onStep, confirmFn);
        this.history.push({ role: "assistant", content: reply });
        await this.saveHistory();
        this.post({ type: "assistantMessage", text: reply });
        this.accumulateUsage(usage);
      } else {
        this.post({ type: "assistantStreamStart" });
        const { text: reply, usage } = await streamChatMessage(config, this.history, (evt) => {
          this.post({
            type: evt.type === "reasoning" ? "assistantReasoningChunk" : "assistantStreamChunk",
            text: evt.text
          });
        });
        this.history.push({ role: "assistant", content: reply });
        await this.saveHistory();
        // reply передаём и сюда — если контент не пришёл кусками (весь ответ
        // оказался в "рассуждениях"), webview подставит его как fallback.
        this.post({ type: "assistantStreamEnd", text: reply });
        this.accumulateUsage(usage);
      }
    } catch (err: any) {
      this.post({ type: "assistantError", text: err?.message ?? String(err) });
    }
  }

  private async accumulateUsage(usage: UsageInfo) {
    this.totalUsage = {
      inputTokens: this.totalUsage.inputTokens + usage.inputTokens,
      outputTokens: this.totalUsage.outputTokens + usage.outputTokens,
      estimated: this.totalUsage.estimated || usage.estimated
    };
    await this.saveUsage();
    this.postUsageUpdate(usage);
  }

  private post(message: unknown) {
    this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css")
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>LunaCode Chat</title>
</head>
<body>
  <div id="header">
    <div id="mode-switch">
      <button class="mode-btn" id="mode-chat" data-mode="chat" title="Обычный чат">💬 Chat</button>
      <button class="mode-btn" id="mode-agent" data-mode="agent" title="ИИ может читать и писать файлы">🤖 Agent</button>
    </div>
    <button id="model-badge" title="Сменить модель">Модель: …</button>
  </div>
  <div id="messages"></div>
  <div id="footer">
    <div id="usage-bar">
      <span id="usage-text">Токены: —</span>
      <button id="usage-reset" title="Сбросить счётчик токенов">↺</button>
    </div>
    <div id="input-row">
      <button id="terminal-btn" title="Открыть терминал LunaCode">⌘</button>
      <textarea id="input" placeholder="Спросите ИИ-агента LunaCode..." rows="1"></textarea>
      <button id="send" title="Отправить (Enter)">➤</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

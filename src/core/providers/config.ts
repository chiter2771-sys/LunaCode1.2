import * as vscode from "vscode";
import { LunaCodeConfig } from "../../aiClient";
export async function getLunaCodeConfig(context: vscode.ExtensionContext): Promise<LunaCodeConfig> {
  const cfg = vscode.workspace.getConfiguration("lunacode");
  const provider = cfg.get<string>("provider", "anthropic") as LunaCodeConfig["provider"];
  return { provider, model: cfg.get<string>("model", ""), baseUrl: cfg.get<string>("baseUrl", ""), systemPrompt: cfg.get<string>("systemPrompt", ""), maxTokens: cfg.get<number>("maxTokens", 2048), temperature: cfg.get<number>("temperature", 0.4), apiKey: (await context.secrets.get(`lunacode.apiKey.${provider}`)) ?? "" };
}

import * as vscode from "vscode";
import { TOOLS, executeTool, ConfirmFn } from "./tools";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LunaCodeConfig {
  provider: "anthropic" | "openai" | "hhchat" | "custom-openai-compatible";
  model: string;
  baseUrl: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  apiKey: string;
}

/**
 * Модели, доступные через шлюз HHChat Pro (https://hhchat.xyz).
 * Список согласно их user-guide (https://hhchat.xyz/user-guide).
 * Шлюз полностью OpenAI-совместимый: base URL https://hhchat.xyz/v1,
 * авторизация — обычный "Authorization: Bearer <token>".
 */
export { HHCHAT_MODELS } from "./providers/hhchat/models";

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  /** true, если провайдер не вернул точные цифры и это грубая оценка по длине текста */
  estimated: boolean;
}

/** Грубая оценка количества токенов (~4 символа на токен), когда API не вернул usage. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function emptyUsage(): UsageInfo {
  return { inputTokens: 0, outputTokens: 0, estimated: false };
}

function addUsage(a: UsageInfo, b: UsageInfo): UsageInfo {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimated: a.estimated || b.estimated
  };
}

export interface PricingConfig {
  pricePerMillionInput: number;
  pricePerMillionOutput: number;
}

/**
 * Пользователь может указать свою цену за 1 млн токенов (зависит от
 * провайдера/модели — LunaCode не хранит прайс-лист, чтобы не выдавать
 * неточные цифры). По умолчанию 0 — тогда стоимость не показывается,
 * только количество токенов.
 */
export function getPricingConfig(): PricingConfig {
  const cfg = vscode.workspace.getConfiguration("lunacode");
  return {
    pricePerMillionInput: cfg.get<number>("pricePerMillionInputTokens", 0),
    pricePerMillionOutput: cfg.get<number>("pricePerMillionOutputTokens", 0)
  };
}

export function estimateCost(usage: UsageInfo, pricing: PricingConfig): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.pricePerMillionInput +
    (usage.outputTokens / 1_000_000) * pricing.pricePerMillionOutput
  );
}

/**
 * Читает текущую конфигурацию LunaCode из настроек VS Code + SecretStorage.
 */
export async function getConfig(
  context: vscode.ExtensionContext
): Promise<LunaCodeConfig> {
  const cfg = vscode.workspace.getConfiguration("lunacode");
  const provider = cfg.get<string>("provider", "anthropic") as LunaCodeConfig["provider"];
  const apiKey = (await context.secrets.get(`lunacode.apiKey.${provider}`)) ?? "";

  return {
    provider,
    model: cfg.get<string>("model", "claude-sonnet-4-6"),
    baseUrl: cfg.get<string>("baseUrl", ""),
    systemPrompt: cfg.get<string>("systemPrompt", ""),
    maxTokens: cfg.get<number>("maxTokens", 2048),
    temperature: cfg.get<number>("temperature", 0.4),
    apiKey
  };
}

function defaultBaseUrl(provider: LunaCodeConfig["provider"]): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1/messages";
    case "openai":
      return "https://api.openai.com/v1/chat/completions";
    case "hhchat":
      return "https://hhchat.xyz/v1/chat/completions";
    case "custom-openai-compatible":
      return "http://localhost:11434/v1/chat/completions";
  }
}

/**
 * Приводит указанный пользователем baseUrl к полному endpoint'у запроса.
 * Многие гайды (в т.ч. HHChat Pro) просят указывать "базовый" URL вида
 * "https://hhchat.xyz/v1" — библиотеки OpenAI SDK сами дописывают
 * "/chat/completions". Мы делаем fetch напрямую, поэтому дописываем путь
 * сами, если пользователь его не указал явно. Работает и если он уже
 * указал полный путь — тогда ничего не меняется.
 */
function resolveUrl(config: LunaCodeConfig): string {
  const custom = config.baseUrl?.trim();
  if (!custom) return defaultBaseUrl(config.provider);

  const trimmed = custom.replace(/\/+$/, "");

  if (config.provider === "anthropic") {
    return trimmed.endsWith("/messages") ? trimmed : `${trimmed}/messages`;
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Некоторые шлюзы (в т.ч. HHChat Pro, работающий поверх OpenRouter) даже в
 * НЕ-потоковом ответе иногда подмешивают служебные keep-alive строки вида
 * ": OPENROUTER PROCESSING" (формат SSE-комментария), чтобы прокси не
 * обрывал долгое соединение, пока модель думает. res.json() падает на
 * такой "грязной" JSON-строке — этот парсер сначала вырезает подобные
 * строки, а если тело всё равно осталось в SSE-формате (строки "data: {...}"),
 * достаёт из него последний валидный JSON-объект.
 */
async function parseJsonBody(res: Response): Promise<any> {
  const raw = await res.text();

  const withoutComments = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(":"))
    .join("\n")
    .trim();

  try {
    return JSON.parse(withoutComments);
  } catch {
    // возможно это SSE-поток из "data: {...}" строк — берём последнюю валидную
    const dataLines = withoutComments
      .split("\n")
      .filter((l) => l.trim().startsWith("data:"))
      .map((l) => l.trim().slice(5).trim())
      .filter((l) => l && l !== "[DONE]");

    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(dataLines[i]);
      } catch {
        continue;
      }
    }

    throw new Error(
      `Не удалось разобрать ответ сервера как JSON. Начало ответа: ${raw.slice(0, 300)}`
    );
  }
}

/**
 * Формирует понятное сообщение об ошибке API с подсказкой для частых причин
 * (неверный baseUrl → 404, неверный/просроченный ключ → 401/403).
 */
async function throwHttpError(res: Response, label: string): Promise<never> {
  const bodyText = await res.text();
  let hint = "";
  if (res.status === 404) {
    hint =
      " Подсказка: похоже, неверный адрес API. Проверьте настройку lunacode.baseUrl — если она заполнена вручную, укажите либо базовый URL провайдера (LunaCode сам дописывает нужный путь), либо оставьте поле пустым, чтобы использовался адрес по умолчанию для выбранного провайдера.";
  } else if (res.status === 401 || res.status === 403) {
    hint =
      ' Подсказка: проверьте API-ключ через команду "LunaCode: Указать API-ключ ИИ-агента" — возможно он неверный, просрочен или сохранён для другого провайдера.';
  }
  throw new Error(`${label} ошибка ${res.status}: ${bodyText}${hint}`);
}

/**
 * Отправляет историю сообщений выбранному ИИ-провайдеру и возвращает текст ответа.
 * Провайдер, модель, ключ и endpoint полностью настраиваются пользователем — это
 * и есть "гибкая настройка доступа для подключения ИИ агента".
 */
export async function sendChatMessage(
  config: LunaCodeConfig,
  history: ChatMessage[]
): Promise<string> {
  if (!config.apiKey) {
    throw new Error(
      `API-ключ не задан для провайдера "${config.provider}". Выполните команду "LunaCode: Указать API-ключ ИИ-агента".`
    );
  }

  const url = resolveUrl(config);

  if (config.provider === "anthropic") {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        system: config.systemPrompt,
        messages: history.map((m) => ({ role: m.role, content: m.content }))
      })
    });

    if (!res.ok) {
      await throwHttpError(res, "Anthropic API");
    }
    const data: any = await parseJsonBody(res);
    const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
    const thinkingBlock = (data.content ?? []).find((b: any) => b.type === "thinking");
    return textBlock?.text || thinkingBlock?.thinking || "(пустой ответ)";
  }

  // OpenAI, HHChat Pro (hhchat.xyz) и любой другой OpenAI-совместимый сервер
  // (Ollama, LM Studio, vLLM, кастомный прокси и т.д.) — все используют один
  // и тот же формат Chat Completions с заголовком Authorization: Bearer.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages: [
        { role: "system", content: config.systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content }))
      ]
    })
  });

  if (!res.ok) {
    await throwHttpError(res, "API");
  }
  const data: any = await parseJsonBody(res);
  const message = data.choices?.[0]?.message;
  return message?.content || message?.reasoning_content || message?.reasoning || "(пустой ответ)";
}

/**
 * Проверка баланса токенов на шлюзе HHChat Pro.
 * Согласно https://hhchat.xyz/user-guide баланс проверяется отдельным
 * эндпоинтом с авторизацией через заголовок x-api-key (а не Bearer).
 */
export async function checkHHChatBalance(apiKey: string): Promise<string> {
  const res = await fetch("https://hhchat.xyz/v1/token-balance", {
    method: "GET",
    headers: {
      "x-api-key": apiKey
    }
  });
  if (!res.ok) {
    throw new Error(`Ошибка проверки баланса ${res.status}: ${await res.text()}`);
  }
  const data: any = await parseJsonBody(res);
  return JSON.stringify(data, null, 2);
}

/* ------------------------------------------------------------------ */
/*  СТРИМИНГ (обычный чат, без инструментов)                          */
/* ------------------------------------------------------------------ */

async function readSSE(
  res: Response,
  onEvent: (rawData: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!res.body) throw new Error("Сервер не вернул поток ответа.");
  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    if (signal?.aborted) { try { await reader.cancel(); } catch {} ; break; }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data) onEvent(data);
    }
  }
}

export interface StreamDeltaEvent {
  type: "content" | "reasoning";
  text: string;
}

/**
 * Потоковая отправка сообщения: onDelta вызывается по мере поступления
 * кусочков текста (type: "content") и, если модель их присылает отдельно,
 * кусочков рассуждений (type: "reasoning" — поле "reasoning"/"reasoning_content"
 * у OpenAI-совместимых reasoning-моделей вроде Kimi K3, или thinking_delta у
 * Anthropic). Если контент так и остался пустым, а рассуждения — нет,
 * в качестве текста ответа используются рассуждения (иначе пользователь
 * увидел бы "пустой ответ" при потраченных токенах).
 */
export async function streamChatMessage(
  config: LunaCodeConfig,
  history: ChatMessage[],
  onDelta: (evt: StreamDeltaEvent) => void,
  signal?: AbortSignal
): Promise<{ text: string; reasoning: string; usage: UsageInfo }> {
  if (!config.apiKey) {
    throw new Error(
      `API-ключ не задан для провайдера "${config.provider}". Выполните команду "LunaCode: Указать API-ключ ИИ-агента".`
    );
  }
  const url = resolveUrl(config);
  let contentFull = "";
  let reasoningFull = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let gotRealUsage = false;

  if (config.provider === "anthropic") {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        system: config.systemPrompt,
        stream: true,
        messages: history.map((m) => ({ role: m.role, content: m.content }))
      })
    });
    if (!res.ok) {
      await throwHttpError(res, "Anthropic API");
    }
    await readSSE(res, (raw) => {
      try {
        const evt = JSON.parse(raw);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          contentFull += evt.delta.text;
          onDelta({ type: "content", text: evt.delta.text });
        } else if (evt.type === "content_block_delta" && evt.delta?.type === "thinking_delta") {
          reasoningFull += evt.delta.thinking ?? "";
          onDelta({ type: "reasoning", text: evt.delta.thinking ?? "" });
        } else if (evt.type === "message_start" && evt.message?.usage?.input_tokens != null) {
          inputTokens = evt.message.usage.input_tokens;
          gotRealUsage = true;
        } else if (evt.type === "message_delta" && evt.usage?.output_tokens != null) {
          outputTokens = evt.usage.output_tokens;
          gotRealUsage = true;
        }
      } catch {
        /* игнорируем неполные/служебные события */
      }
    }, signal);
    const usage: UsageInfo = gotRealUsage
      ? { inputTokens, outputTokens, estimated: false }
      : {
          inputTokens: estimateTokens(history.map((m) => m.content).join("\n")),
          outputTokens: estimateTokens(contentFull || reasoningFull),
          estimated: true
        };
    const usedReasoningAsAnswer = contentFull.trim() === "" && reasoningFull.trim() !== "";
    return {
      text: usedReasoningAsAnswer ? reasoningFull : contentFull,
      reasoning: usedReasoningAsAnswer ? "" : reasoningFull,
      usage
    };
  }

  // OpenAI / HHChat Pro / любой OpenAI-совместимый сервер
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: config.systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content }))
      ]
    })
  });
  if (!res.ok) {
    await throwHttpError(res, "API");
  }
  await readSSE(res, (raw) => {
    if (raw === "[DONE]") return;
    try {
      const evt = JSON.parse(raw);
      const delta = evt.choices?.[0]?.delta;
      const contentPiece: string | undefined = delta?.content;
      // Reasoning-модели (Kimi K3, DeepSeek R1 и т.д.) через OpenAI-совместимые
      // шлюзы часто присылают "мысли" отдельным полем reasoning/reasoning_content.
      const reasoningPiece: string | undefined = delta?.reasoning ?? delta?.reasoning_content;
      if (contentPiece) {
        contentFull += contentPiece;
        onDelta({ type: "content", text: contentPiece });
      }
      if (reasoningPiece) {
        reasoningFull += reasoningPiece;
        onDelta({ type: "reasoning", text: reasoningPiece });
      }
      if (evt.usage?.prompt_tokens != null) {
        inputTokens = evt.usage.prompt_tokens;
        outputTokens = evt.usage.completion_tokens ?? outputTokens;
        gotRealUsage = true;
      }
    } catch {
      /* игнорируем неполные строки */
    }
  }, signal);
  const usage: UsageInfo = gotRealUsage
    ? { inputTokens, outputTokens, estimated: false }
    : {
        inputTokens: estimateTokens(history.map((m) => m.content).join("\n")),
        outputTokens: estimateTokens(contentFull || reasoningFull),
        estimated: true
      };
  const usedReasoningAsAnswer = contentFull.trim() === "" && reasoningFull.trim() !== "";
  return {
    text: usedReasoningAsAnswer ? reasoningFull : contentFull,
    reasoning: usedReasoningAsAnswer ? "" : reasoningFull,
    usage
  };
}

/* ------------------------------------------------------------------ */
/*  AGENTIC-РЕЖИМ: цикл вызова инструментов (tool calling)            */
/* ------------------------------------------------------------------ */

export interface AgentStepEvent {
  type: "tool-call" | "tool-result" | "final";
  tool?: string;
  args?: any;
  text?: string;
}

function anthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }));
}

function openaiTools() {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

const MAX_AGENT_STEPS = 8;

/**
 * Запускает agentic-цикл: модель может многократно вызывать инструменты
 * (чтение/запись файлов, список папок) прежде чем дать финальный ответ.
 * onStep вызывается на каждом шаге для отображения прогресса в чате.
 */
export async function runAgentTurn(
  config: LunaCodeConfig,
  history: ChatMessage[],
  onStep: (event: AgentStepEvent) => void,
  confirmFn: ConfirmFn,
  signal?: AbortSignal
): Promise<{ text: string; usage: UsageInfo }> {
  if (!config.apiKey) {
    throw new Error(
      `API-ключ не задан для провайдера "${config.provider}". Выполните команду "LunaCode: Указать API-ключ ИИ-агента".`
    );
  }
  const url = resolveUrl(config);
  let usage = emptyUsage();

  if (config.provider === "anthropic") {
    const msgs: any[] = history.map((m) => ({ role: m.role, content: m.content }));

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      if (signal?.aborted) throw new Error("Операция отменена пользователем.");
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01"
        },
        signal,
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          system: config.systemPrompt,
          tools: anthropicTools(),
          messages: msgs
        })
      });
      if (!res.ok) await throwHttpError(res, "Anthropic API");
      const data: any = await parseJsonBody(res);
      if (data.usage) {
        usage = addUsage(usage, {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          estimated: false
        });
      }
      const blocks: any[] = data.content ?? [];
      const toolUses = blocks.filter((b) => b.type === "tool_use");

      if (toolUses.length === 0) {
        const text =
          blocks.find((b) => b.type === "text")?.text ??
          blocks.find((b) => b.type === "thinking")?.thinking ??
          "(пустой ответ)";
        onStep({ type: "final", text });
        return { text, usage };
      }

      msgs.push({ role: "assistant", content: blocks });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        onStep({ type: "tool-call", tool: tu.name, args: tu.input });
        const result = await executeTool(tu.name, tu.input ?? {}, confirmFn, signal);
        onStep({ type: "tool-result", tool: tu.name, text: result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result
        });
      }
      msgs.push({ role: "user", content: toolResults });
    }
    throw new Error("Достигнут лимит шагов агента без финального ответа.");
  }

  // OpenAI / HHChat Pro / OpenAI-совместимый сервер
  const msgs: any[] = [
    { role: "system", content: config.systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content }))
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (signal?.aborted) throw new Error("Операция отменена пользователем.");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`
      },
      signal,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        tools: openaiTools(),
        messages: msgs
      })
    });
    if (!res.ok) await throwHttpError(res, "API");
    const data: any = await parseJsonBody(res);
    if (data.usage) {
      usage = addUsage(usage, {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
        estimated: false
      });
    }
    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      const text =
        message?.content || message?.reasoning_content || message?.reasoning || "(пустой ответ)";
      onStep({ type: "final", text });
      return { text, usage };
    }

    msgs.push(message);
    for (const call of toolCalls) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        /* некорректный JSON от модели — оставляем пустые args */
      }
      onStep({ type: "tool-call", tool: call.function?.name, args });
      const result = await executeTool(call.function?.name, args, confirmFn, signal);
      onStep({ type: "tool-result", tool: call.function?.name, text: result });
      msgs.push({
        role: "tool",
        tool_call_id: call.id,
        content: result
      });
    }
  }
  throw new Error("Достигнут лимит шагов агента без финального ответа.");
}

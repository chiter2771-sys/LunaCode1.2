import { UsageInfo } from "../../aiClient";

export type ChatRole = "system" | "user" | "assistant" | "tool";
export interface ProviderMessage { role: ChatRole; content: string | unknown[]; toolCallId?: string; toolCalls?: ToolCall[]; }
export type ModelCapability = "streaming" | "toolCalling" | "reasoning" | "vision" | "structuredOutput" | "parallelToolCalls" | "systemPrompt" | "contextCaching";
export interface ModelInfo { id: string; name: string; contextWindow?: number; maxOutputTokens?: number; capabilities: ModelCapability[]; inputPricePerMillion?: number; outputPricePerMillion?: number; }
export interface ToolSchema { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] }; readonly?: boolean; dangerous?: boolean; }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface ChatRequest { model: string; messages: ProviderMessage[]; systemPrompt?: string; maxTokens: number; temperature: number; tools?: ToolSchema[]; signal?: AbortSignal; }
export interface ChatResponse { text: string; reasoning?: string; toolCalls?: ToolCall[]; raw?: unknown; usage: UsageInfo; }
export type StreamEvent = { type: "content" | "reasoning" | "toolCall" | "done"; text?: string; toolCall?: ToolCall; usage?: UsageInfo };
export interface AIProvider { id: string; name: string; getModels(): Promise<ModelInfo[]>; chat(request: ChatRequest): Promise<ChatResponse>; stream(request: ChatRequest): AsyncIterable<StreamEvent>; supports(capability: ModelCapability, model?: string): boolean; }

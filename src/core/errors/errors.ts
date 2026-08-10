export class LunaCodeError extends Error { constructor(message: string, public readonly code: string, public readonly recoverable = false) { super(message); this.name = new.target.name; } }
export class NetworkError extends LunaCodeError { constructor(message: string) { super(message, "network", true); } }
export class AuthenticationError extends LunaCodeError { constructor(message: string) { super(message, "authentication", false); } }
export class RateLimitError extends LunaCodeError { constructor(message: string, public readonly retryAfterMs?: number) { super(message, "rate_limit", true); } }
export class ContextLimitError extends LunaCodeError { constructor(message: string) { super(message, "context_limit", true); } }
export class ProviderError extends LunaCodeError { constructor(message: string, recoverable = false) { super(message, "provider", recoverable); } }
export class ToolError extends LunaCodeError { constructor(message: string) { super(message, "tool", true); } }
export class PermissionError extends LunaCodeError { constructor(message: string) { super(message, "permission", false); } }
export class ValidationError extends LunaCodeError { constructor(message: string) { super(message, "validation", true); } }
export class CancellationError extends LunaCodeError { constructor(message = "Операция отменена пользователем.") { super(message, "cancelled", true); } }

export function toUserMessage(error: unknown): string {
  if (error instanceof LunaCodeError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

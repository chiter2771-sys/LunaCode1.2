import { LunaTool, ToolDefinition, ToolExecutionContext } from "./types";
export class ToolRegistry {
  private readonly tools = new Map<string, LunaTool>();
  register(tool: LunaTool): void { if (this.tools.has(tool.definition.name)) throw new Error(`Tool already registered: ${tool.definition.name}`); this.tools.set(tool.definition.name, tool); }
  get(name: string): LunaTool | undefined { return this.tools.get(name); }
  list(): ToolDefinition[] { return [...this.tools.values()].map((t) => t.definition); }
  async execute(name: string, args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> { const tool = this.get(name); if (!tool) return `Неизвестный инструмент: ${name}`; if (context.signal?.aborted) return "Операция отменена."; return tool.execute(args, context); }
}

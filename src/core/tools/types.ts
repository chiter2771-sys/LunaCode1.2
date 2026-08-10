export type ToolCategory = "read" | "write" | "delete" | "terminal" | "git" | "network" | "diagnostics" | "symbols";
export interface ToolDefinition { name: string; description: string; category: ToolCategory; readonly: boolean; safeForParallel: boolean; parameters: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] }; }
export type ConfirmFn = (message: string, detail?: string) => Promise<boolean>;
export interface ToolExecutionContext { confirm: ConfirmFn; signal?: AbortSignal; }
export interface LunaTool { definition: ToolDefinition; execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string>; }

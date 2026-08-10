export interface BudgetItem { id: string; text: string; priority: number; kind: string; }
export interface BudgetResult { items: BudgetItem[]; estimatedTokens: number; omitted: number; }
export class ContextBudgetManager {
  constructor(private readonly contextWindow = 32000, private readonly reservedOutputTokens = 4096) {}
  estimateTokens(text: string): number { return Math.max(1, Math.ceil(text.length / 4)); }
  fit(items: BudgetItem[]): BudgetResult {
    const max = Math.max(1024, this.contextWindow - this.reservedOutputTokens);
    const sorted = [...items].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const kept: BudgetItem[] = []; let used = 0;
    for (const item of sorted) { const cost = this.estimateTokens(item.text); if (used + cost <= max) { kept.push(item); used += cost; } }
    return { items: kept, estimatedTokens: used, omitted: items.length - kept.length };
  }
}

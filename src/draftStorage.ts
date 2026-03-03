import * as vscode from 'vscode';

const DRAFTS_KEY = 'blog-auto.drafts';
const MAX_DRAFTS = 30;

export interface DraftEntry {
  id: string;
  title: string;
  content: string;
  createdAt: number;
}

export function getDrafts(context: vscode.ExtensionContext): DraftEntry[] {
  const raw = context.globalState.get<DraftEntry[]>(DRAFTS_KEY, []);
  return raw.slice(0, MAX_DRAFTS);
}

export function saveDraft(
  context: vscode.ExtensionContext,
  content: string,
  title?: string
): DraftEntry {
  const drafts = getDrafts(context);
  const entry: DraftEntry = {
    id: `draft-${Date.now()}`,
    title: title || `정리 ${new Date().toISOString().slice(0, 10)}`,
    content,
    createdAt: Date.now(),
  };
  const next = [entry, ...drafts].slice(0, MAX_DRAFTS);
  context.globalState.update(DRAFTS_KEY, next);
  return entry;
}

export function loadDraft(context: vscode.ExtensionContext, id: string): string | undefined {
  const drafts = getDrafts(context);
  const found = drafts.find((d) => d.id === id);
  return found?.content;
}

export function deleteDraft(context: vscode.ExtensionContext, id: string): void {
  const drafts = getDrafts(context).filter((d) => d.id !== id);
  context.globalState.update(DRAFTS_KEY, drafts);
}

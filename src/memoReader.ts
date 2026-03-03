import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 워크스페이스 기준 상대 경로로 메모 파일 내용 읽기.
 * 블로그 정리본에 "오늘 메모"로 병합할 때 사용.
 */
export async function readMemoFromWorkspace(
  workspaceRoot: string,
  relativePath: string
): Promise<string | null> {
  if (!relativePath.trim()) return null;
  const fullPath = path.join(workspaceRoot, relativePath.replace(/^\//, ''));
  try {
    const uri = vscode.Uri.file(fullPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    return doc.getText().trim() || null;
  } catch {
    return null;
  }
}

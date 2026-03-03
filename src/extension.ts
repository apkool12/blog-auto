import * as vscode from 'vscode';
import { registerBlogView } from './blogViewProvider';

/** 오늘 날짜 문자열 (YYYY-MM-DD) */
function getTodayString(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/** 현재 에디터 내용(또는 선택 영역)을 블로그용 포스트로 정리 */
function formatAsBlogPost(content: string): string {
  const today = getTodayString();
  const title = `오늘 한 일 (${today})`;
  const divider = '\n---\n\n';
  const body = content.trim();
  return `# ${title}${divider}${body}\n`;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Plugin이 활성화되었습니다.');

  registerBlogView(context);

  const helloCommand = vscode.commands.registerCommand(
    'blog-auto.helloWorld',
    () => {
      vscode.window.showInformationMessage('Hello from Cursor Plugin!');
    }
  );

  const formatTodayCommand = vscode.commands.registerCommand(
    'blog-auto.formatTodayPost',
    async () => {
      const editor = vscode.window.activeTextEditor;
      let content = '';

      if (editor) {
        const selection = editor.selection;
        content = selection.isEmpty
          ? editor.document.getText()
          : editor.document.getText(selection);
      }

      if (!content.trim()) {
        vscode.window.showInformationMessage(
          '열린 문서에서 정리할 내용을 선택하거나, 문서 전체를 정리하려면 선택 없이 명령을 실행하세요.'
        );
        return;
      }

      const formatted = formatAsBlogPost(content);
      const doc = await vscode.workspace.openTextDocument({
        content: formatted,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(
        '블로그용으로 정리했습니다. 필요한 만큼 수정한 뒤 복사해서 티스토리/벨로그에 붙여넣으세요.'
      );
    }
  );

  context.subscriptions.push(helloCommand, formatTodayCommand);
}

export function deactivate() {
  console.log('Cursor Plugin이 비활성화되었습니다.');
}

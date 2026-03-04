import * as vscode from "vscode";
import {
  getWorkspaceRoot,
  getBranches,
  getCommitsForBranchesInRange,
  getDateRangeForPreset,
  type CommitInfo,
  type DateRange,
  type DiffOptions,
} from "./gitHelper";
import {
  getDrafts,
  saveDraft,
  loadDraft,
  type DraftEntry,
} from "./draftStorage";
import { readMemoFromWorkspace } from "./memoReader";
import {
  fetchBlogStyleSamples,
  getStoredStyleSamples,
  setStoredStyleSamples,
} from "./styleHelper";

const VIEW_ID = "cursorPlugin.blogView";

/** 블로그 친화적 에러/안내 메시지 (재검토 포인트: 문구 톤 통일) */
const MSG = {
  NO_WORKSPACE: "워크스페이스 폴더를 열어 주세요. (파일 > 폴더 열기)",
  NO_BRANCHES:
    "이 폴더가 Git 저장소가 아니거나 로컬 브랜치가 없어요. 터미널에서 git status를 실행해 보세요.",
  NO_BRANCH_SELECTED: "정리할 브랜치를 하나 이상 선택해 주세요.",
  NO_COMMITS:
    "선택한 기간에 커밋이 없어요. 날짜 범위를 바꿔 보거나, 다른 브랜치를 선택해 보세요.",
  NO_CONTENT:
    "정리된 내용이 없어요. 먼저 커밋 정리나 현재 문서 정리를 실행해 주세요.",
  LOAD_STYLE_FIRST:
    '말투 샘플을 먼저 불러와 주세요. (블로그 주소 입력 후 "말투 샘플 불러오기")',
  BLOG_URL_REQUIRED: "블로그 주소를 입력하거나 설정에 저장해 주세요.",
} as const;

function getTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getConfig() {
  return vscode.workspace.getConfiguration("blog-auto");
}

/** 설정에서 제목/인트로 템플릿 + diff 옵션 생성 */
function getTemplateAndDiffOptions(config: vscode.WorkspaceConfiguration) {
  const titleFormat = config.get<string>(
    "postTitleFormat",
    "오늘 한 일 ({{date}})",
  );
  const introTemplate = config.get<string>(
    "introTemplate",
    "오늘은 **{{branch}}** 브랜치에서 작업했어요.",
  );
  const extStr = config.get<string>(
    "diffIncludeExtensions",
    "ts,tsx,js,jsx,css,html,vue,json",
  );
  const skipStr = config.get<string>(
    "diffSkipPatterns",
    "package-lock\\.json,.lock$,node_modules,^dist/",
  );
  const includeExtensions = new RegExp(
    "\\.(" +
      extStr
        .split(",")
        .map((e) => e.trim().replace(/^\./, ""))
        .join("|") +
      ")$",
    "i",
  );
  let skipPatterns: RegExp;
  try {
    skipPatterns = new RegExp(
      skipStr
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("|"),
      "i",
    );
  } catch {
    skipPatterns = /package-lock\.json|\.lock$|node_modules|^dist\//i;
  }
  const diffOptions: Partial<DiffOptions> = {
    maxLinesPerCommit: config.get<number>("diffMaxLinesPerCommit", 120),
    maxLinesPerFile: config.get<number>("diffMaxLinesPerFile", 35),
    includeExtensions,
    skipPatterns,
  };
  return { titleFormat, introTemplate, diffOptions };
}

function formatAsBlogPost(content: string, titleFormat?: string): string {
  const date = getTodayString();
  const title = (titleFormat || "오늘 한 일 ({{date}})").replace(
    /\{\{date\}\}/g,
    date,
  );
  const divider = "\n---\n\n";
  const body = content.trim();
  return `# ${title}${divider}${body}\n`;
}

/** Cursor 채팅에 붙여넣을 말투 적용 프롬프트 — 구조화된 지시 + 예시 + 초안 */
function buildCursorStylePrompt(
  styleSamples: string,
  contentToRewrite: string,
): string {
  const role = `[역할]
너는 내 블로그 글 말투를 정확히 흉내하는 글쓰기 도우미야.`;

  const analyze = `[말투 분석]
아래 [내 블로그 말투 예시]를 읽고 다음을 파악해:
- 반말/존댓말 (해요체, 해체 등)
- 문장 길이·호흡 (짧은 문장 위주인지, 한 문단에 몇 문장인지)
- 끝맺음 습관 (~해요, ~었어요, ~다, ~함 등)
- 이모지·기호 사용 여부
- 단락 구조 (소제목 사용, 불릿 정리 등)`;

  const rules = `[작성 규칙]
- 아래 [작성할 초안]의 **정보(커밋 내용, 변경 파일, 한 일 요약)**는 빠짐없이 유지해.
- 문장만 위에서 파악한 내 말투·스타일로 바꿔서 다시 써줘.
- 다른 설명·메타 코멘트 없이 **재작성된 블로그 글 전체**만 출력해.`;

  const sampleLabel = `[내 블로그 말투 예시]`;
  const draftLabel = `[작성할 초안]`;

  return [
    role,
    "",
    analyze,
    "",
    rules,
    "",
    sampleLabel,
    styleSamples.slice(0, 8000),
    "",
    draftLabel,
    contentToRewrite,
  ].join("\n");
}

/** Cursor에 붙여넣을 "기술·어려움·진행 내용 요약" 요청 프롬프트 */
function buildSummaryRequestPrompt(commitListContent: string): string {
  const role = `[역할]
아래 커밋·파일 변경 내역을 분석해서 **티스토리·벨로그 같은 일반 테크 블로그·일상 블로그에 그대로 쓸 수 있는 본문 초안**을 만들어줘.`;

  const audience = `[대상과 톤]
- **독자**: 개발에 관심 있는 동료, 후배, 또는 "오늘 뭘 했는지" 기록해 두려는 나 자신.
- **목적**: 테크 블로그 포스트 또는 일상적인 "오늘 한 일" 글로 바로 붙여 넣을 수 있어야 함.
- **문체**: 해요체. 한 문장은 짧고 읽기 쉽게. 전문 용어는 필요할 때만 쓰고, 쓸 때는 한 번만 풀어서 설명해도 됨.
- **금지**: 메타 코멘트("위 내용을 정리하면…"), 과한 격식, 슬랙/이슈 트래커 스타일의 나열만 하지 마. 블로그 한 편의 글로 읽히게.`;

  const outputFormat = `[출력 형식]
- 아래 마크다운 구조만 사용해서 출력해. 다른 설명 없이 **블로그 본문으로 쓸 수 있는 내용만** 출력해.
- 각 섹션 제목(##)은 그대로 두고, 본문만 채워줘.

\`\`\`
## 사용된 기술

## 어려움이나 고려한 점

## 진행한 작업 요약
\`\`\``;

  const request = `[요청]
[오늘 커밋·변경 내역]을 보고 다음 세 섹션을 **블로그 포스트 한 편 분량**으로 채워줘.

1. **사용된 기술**
   - 커밋·변경 파일에서 실제로 쓰인 기술만 나열해 (프레임워크, 라이브러리, 언어, 도구). 근거 없는 추측은 넣지 마.
   - 테크 블로그 독자도, 일상 블로그만 보는 독자도 "뭘로 했구나" 알 수 있게. 불릿(·) 또는 한두 줄 나열.

2. **어려움이나 고려한 점**
   - 커밋 제목·변경 규모에서 읽히는 "고민한 점"이 있으면 1~2문장으로. 없으면 "이번에는 특별히 적어둘 만한 어려움은 없었어요." 한 줄로.

3. **진행한 작업 요약**
   - **시간순**으로 "무엇을 만들고/바꿨는지" 2~4문장으로 자연스럽게. 일상 블로그의 "오늘 한 일"처럼 흐름 있게.
   - 예: "Next.js 프로젝트를 세팅하고, 공통 레이아웃과 헤더·네비를 추가했어요. 그다음 problems 페이지를 reviews로 바꾼 뒤, 포커스·active 상태 같은 접근성도 조금 넣었어요."`;

  const dataLabel = `[오늘 커밋·변경 내역]`;
  return [
    role,
    "",
    audience,
    "",
    outputFormat,
    "",
    request,
    "",
    dataLabel,
    "",
    commitListContent,
  ].join("\n");
}

/** 커밋 한 블록: 제목 + (해시) + 파일 목록 + (옵션) 핵심 코드 diff */
function formatCommitBlock(c: CommitInfo): string {
  const shortHash = c.hash.slice(0, 7);
  const head = `- **${c.subject}** (${shortHash})`;
  const filePart = !c.files?.length
    ? head
    : [
        head,
        ...c.files.map((f) => {
          const stat = f.add > 0 || f.del > 0 ? ` +${f.add} -${f.del}` : "";
          return `  - ${f.path}${stat}`;
        }),
      ].join("\n");
  if (!c.diff?.trim()) return filePart;
  return `${filePart}\n\n\`\`\`diff\n${c.diff}\n\`\`\``;
}

interface FormatPostOptions {
  titleFormat?: string;
  introTemplate?: string;
  dateLabel: string;
  memoSection?: string | null;
}

function formatCommitsAsPost(
  branchCommits: { branch: string; commits: CommitInfo[] }[],
  options: FormatPostOptions,
): string {
  const { titleFormat, introTemplate, dateLabel, memoSection } = options;
  const title = (titleFormat || "오늘 한 일 ({{date}})").replace(
    /\{\{date\}\}/g,
    dateLabel,
  );
  const withCommits = branchCommits.filter(({ commits }) => commits.length > 0);
  if (withCommits.length === 0) {
    return `# ${title}\n\n${options.dateLabel} 기간에 커밋이 없습니다.\n`;
  }

  const branchNames = withCommits.map(({ branch }) => branch);
  const branchPlaceholder =
    branchNames.length === 1
      ? branchNames[0]
      : branchNames.map((b) => `**${b}**`).join(", ");
  const intro = (
    introTemplate || "오늘은 **{{branch}}** 브랜치에서 작업했어요."
  )
    .replace(/\{\{branch\}\}/g, branchNames[0])
    .replace(/\{\{branches\}\}/g, branchPlaceholder);

  const sections = withCommits.map(({ branch, commits }) => {
    const list = commits.map((c) => formatCommitBlock(c)).join("\n\n");
    return branchNames.length === 1 ? list : `**${branch}**\n\n${list}`;
  });

  let body = `${intro}\n\n${sections.join("\n\n")}`;
  if (memoSection?.trim()) {
    body += `\n\n---\n\n## 오늘 메모\n\n${memoSection.trim()}\n`;
  }
  return `# ${title}\n\n${body}\n`;
}

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
      margin: 0;
    }
    .section { margin-bottom: 16px; }
    label { display: block; margin-bottom: 4px; font-weight: 500; }
    input[type="text"], select {
      width: 100%;
      padding: 6px 8px;
      margin-bottom: 6px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
    }
    .branch-list { max-height: 120px; overflow-y: auto; margin: 6px 0; }
    .branch-list label { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-weight: normal; }
    textarea {
      width: 100%;
      min-height: 100px;
      padding: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      resize: vertical;
      font-family: inherit;
    }
    .btn {
      display: inline-block;
      padding: 6px 12px;
      margin-right: 8px;
      margin-top: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
    .checkbox-wrap { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .small-label { font-weight: normal; font-size: 12px; }
  </style>
</head>
<body>
  <div class="section">
    <label>커밋 기준 (날짜·브랜치)</label>
    <label for="datePreset" class="small-label">기간</label>
    <select id="datePreset">
      <option value="today">오늘</option>
      <option value="yesterday">어제</option>
      <option value="last7">지난 7일</option>
      <option value="custom">직접 입력</option>
    </select>
    <div id="customDateWrap" style="display:none;">
      <input type="text" id="customSince" placeholder="시작 YYYY-MM-DD" />
      <input type="text" id="customUntil" placeholder="끝 YYYY-MM-DD (비우면 오늘)" />
    </div>
    <button class="btn" id="btnLoadBranches">브랜치 불러오기</button>
    <div id="branchList" class="branch-list"></div>
    <div class="checkbox-wrap">
      <input type="checkbox" id="includeDiff" />
      <label for="includeDiff" style="margin:0">핵심 코드 변경(diff) 포함</label>
    </div>
    <button class="btn" id="btnFormatCommits">선택 기간·브랜치로 정리</button>
    <p class="hint">기간과 브랜치 선택 후 버튼을 누르세요. 설정에서 diff 줄 수·포함 확장자도 바꿀 수 있어요.</p>
  </div>
  <div class="section">
    <button class="btn" id="btnFormat">현재 문서로 정리</button>
    <p class="hint">열린 에디터 내용을 블로그용 제목·구분선으로 감싸요. 설정의 "블로그 정리"에서 제목 형식 변경 가능.</p>
  </div>
  <div class="section">
    <label>말투 학습 (Cursor 사용)</label>
    <input type="text" id="blogUrl" placeholder="블로그 주소 (티스토리/벨로그 등)" />
    <button class="btn btn-secondary" id="btnLoadStyle">말투 샘플 불러오기</button>
    <p class="hint">샘플 불러온 뒤 "Cursor로 말투 적용"을 누르면 채팅에 붙여넣을 프롬프트가 복사돼요.</p>
  </div>
  <div class="section">
    <label for="output">정리된 내용</label>
    <textarea id="output" placeholder="위에서 정리하면 여기에 표시됩니다. 저장해 두었다가 나중에 불러와서 블로그에 올리면 돼요."></textarea>
    <div style="margin-top: 8px;">
      <button class="btn" id="btnSaveDraft">초안 저장</button>
      <select id="draftList" style="width: auto; min-width: 140px;"><option value="">저장된 초안</option></select>
      <button class="btn btn-secondary" id="btnLoadDraft">불러오기</button>
    </div>
    <div style="margin-top: 8px;">
      <button class="btn" id="btnSummaryRequest">기술·진행 요약 요청 (Cursor에 붙여넣기)</button>
      <button class="btn" id="btnCursorStyle">Cursor로 말투 적용</button>
      <button class="btn" id="btnOpen">새 문서로 열기</button>
      <button class="btn btn-secondary" id="btnCopy">클립보드에 복사</button>
    </div>
    <p class="hint">정리 → 기술·진행 요약 요청으로 Cursor에 붙여넣기 → 요약 받은 뒤 말투 적용 → 초안 저장해 두고 블로그에 올리세요.</p>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const output = document.getElementById('output');
    const branchList = document.getElementById('branchList');
    const blogUrl = document.getElementById('blogUrl');
    const datePreset = document.getElementById('datePreset');
    const customDateWrap = document.getElementById('customDateWrap');
    const draftList = document.getElementById('draftList');

    datePreset.onchange = () => { customDateWrap.style.display = datePreset.value === 'custom' ? 'block' : 'none'; };

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'formatted') { output.value = msg.content || ''; }
      if (msg.type === 'branches') {
        branchList.innerHTML = '';
        (msg.branches || []).forEach(b => {
          const label = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.branch = b;
          label.appendChild(cb);
          label.appendChild(document.createTextNode(b));
          branchList.appendChild(label);
        });
      }
      if (msg.type === 'drafts') {
        draftList.innerHTML = '<option value="">저장된 초안</option>';
        (msg.drafts || []).forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.title + ' (' + (new Date(d.createdAt).toLocaleDateString('ko-KR')) + ')';
          draftList.appendChild(opt);
        });
      }
    });

    document.getElementById('btnLoadBranches').onclick = () => vscode.postMessage({ type: 'getBranches' });
    document.getElementById('btnFormatCommits').onclick = () => {
      const selected = Array.from(branchList.querySelectorAll('input[data-branch]')).filter(el => el.checked).map(el => el.dataset.branch).filter(Boolean);
      vscode.postMessage({
        type: 'formatFromCommits',
        branches: selected,
        includeDiff: document.getElementById('includeDiff').checked,
        datePreset: datePreset.value,
        customSince: document.getElementById('customSince').value.trim(),
        customUntil: document.getElementById('customUntil').value.trim()
      });
    };
    document.getElementById('btnFormat').onclick = () => vscode.postMessage({ type: 'formatDocument' });
    document.getElementById('btnLoadStyle').onclick = () => vscode.postMessage({ type: 'loadStyleSamples', blogUrl: blogUrl.value.trim() });
    document.getElementById('btnSaveDraft').onclick = () => vscode.postMessage({ type: 'saveDraft', content: output.value });
    document.getElementById('btnLoadDraft').onclick = () => vscode.postMessage({ type: 'loadDraft', id: draftList.value });
    vscode.postMessage({ type: 'listDrafts' });
    document.getElementById('btnSummaryRequest').onclick = () => vscode.postMessage({ type: 'summaryRequestPrompt', content: output.value });
    document.getElementById('btnCursorStyle').onclick = () => vscode.postMessage({ type: 'cursorStylePrompt', content: output.value });
    document.getElementById('btnOpen').onclick = () => vscode.postMessage({ type: 'openInEditor', content: output.value });
    document.getElementById('btnCopy').onclick = () => vscode.postMessage({ type: 'copyToClipboard', content: output.value });
  </script>
</body>
</html>`;
}

function setupWebviewMessageHandler(
  webview: vscode.Webview,
  extensionContext: vscode.ExtensionContext,
): void {
  webview.onDidReceiveMessage(async (msg) => {
    try {
      switch (msg.type) {
        case "listDrafts": {
          const drafts = getDrafts(extensionContext);
          webview.postMessage({
            type: "drafts",
            drafts: drafts.map((d) => ({
              id: d.id,
              title: d.title,
              createdAt: d.createdAt,
            })),
          });
          break;
        }
        case "saveDraft": {
          const content = (msg.content || "").trim();
          if (!content) {
            vscode.window.showInformationMessage(MSG.NO_CONTENT);
            return;
          }
          const entry = saveDraft(extensionContext, content);
          const drafts = getDrafts(extensionContext);
          webview.postMessage({
            type: "drafts",
            drafts: drafts.map((d) => ({
              id: d.id,
              title: d.title,
              createdAt: d.createdAt,
            })),
          });
          vscode.window.showInformationMessage(
            `초안을 저장했어요. "${entry.title}"`,
          );
          break;
        }
        case "loadDraft": {
          const id = msg.id;
          if (!id) return;
          const content = loadDraft(extensionContext, id);
          if (content !== undefined) {
            webview.postMessage({ type: "formatted", content });
            vscode.window.showInformationMessage("저장된 초안을 불러왔어요.");
          }
          break;
        }
        case "summaryRequestPrompt": {
          const content = (msg.content || "").trim();
          if (!content) {
            vscode.window.showInformationMessage(MSG.NO_CONTENT);
            return;
          }
          const prompt = buildSummaryRequestPrompt(content);
          await vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "기술·진행 요약 요청 프롬프트를 복사했어요. Cursor 채팅(Ctrl+L)에 붙여넣어 전송하면 사용 기술·어려움·진행 내용이 정리돼요.",
          );
          break;
        }
        case "cursorStylePrompt": {
          const content = (msg.content || "").trim();
          if (!content) {
            vscode.window.showInformationMessage(MSG.NO_CONTENT);
            return;
          }
          const samples = getStoredStyleSamples(extensionContext);
          if (!samples.trim()) {
            vscode.window.showWarningMessage(MSG.LOAD_STYLE_FIRST);
            return;
          }
          const prompt = buildCursorStylePrompt(samples, content);
          await vscode.env.clipboard.writeText(prompt);
          vscode.window.showInformationMessage(
            "Cursor 채팅에 붙여넣을 프롬프트를 복사했어요. Ctrl+L(또는 Cmd+L)로 채팅을 열고 붙여넣기 후 전송하세요.",
          );
          break;
        }
        case "getBranches": {
          const root = getWorkspaceRoot();
          if (!root) {
            vscode.window.showInformationMessage(MSG.NO_WORKSPACE);
            return;
          }
          const branches = getBranches(root);
          webview.postMessage({ type: "branches", branches });
          if (branches.length === 0)
            vscode.window.showInformationMessage(MSG.NO_BRANCHES);
          break;
        }
        case "formatFromCommits": {
          const root = getWorkspaceRoot();
          if (!root) {
            vscode.window.showInformationMessage(MSG.NO_WORKSPACE);
            return;
          }
          const branches: string[] = msg.branches || [];
          if (branches.length === 0) {
            vscode.window.showInformationMessage(MSG.NO_BRANCH_SELECTED);
            return;
          }
          const config = getConfig();
          const { titleFormat, introTemplate, diffOptions } =
            getTemplateAndDiffOptions(config);
          const dateRange = getDateRangeForPreset(
            msg.datePreset || "today",
            msg.customSince,
            msg.customUntil,
          );
          const branchCommits = getCommitsForBranchesInRange(
            root,
            branches,
            dateRange,
            {
              includeDiff: !!msg.includeDiff,
              diffOptions,
            },
          );
          const withCommits = branchCommits.filter(
            ({ commits }) => commits.length > 0,
          );
          if (withCommits.length === 0) {
            vscode.window.showInformationMessage(MSG.NO_COMMITS);
            const dateLabel = dateRange.until
              ? `${dateRange.since} ~ ${dateRange.until}`
              : dateRange.since;
            webview.postMessage({
              type: "formatted",
              content: formatCommitsAsPost(branchCommits, {
                titleFormat,
                introTemplate,
                dateLabel,
                memoSection: null,
              }),
            });
            return;
          }
          const memoPath = config.get<string>("memoFilePath", "");
          const memoSection = memoPath
            ? await readMemoFromWorkspace(root, memoPath)
            : null;
          const dateLabel = dateRange.until
            ? `${dateRange.since} ~ ${dateRange.until}`
            : dateRange.since;
          const formatted = formatCommitsAsPost(branchCommits, {
            titleFormat,
            introTemplate,
            dateLabel,
            memoSection,
          });
          webview.postMessage({ type: "formatted", content: formatted });
          break;
        }
        case "loadStyleSamples": {
          const config = getConfig();
          const url = msg.blogUrl || config.get<string>("blogUrl", "");
          if (!url) {
            vscode.window.showInformationMessage(MSG.BLOG_URL_REQUIRED);
            return;
          }
          const text = await fetchBlogStyleSamples(url);
          setStoredStyleSamples(extensionContext, text);
          vscode.window.showInformationMessage(
            `말투 샘플을 불러왔어요. (${text.length}자)`,
          );
          break;
        }
        case "formatDocument": {
          const editor = vscode.window.activeTextEditor;
          let content = "";
          if (editor) {
            const sel = editor.selection;
            content = sel.isEmpty
              ? editor.document.getText()
              : editor.document.getText(sel);
          }
          if (!content.trim()) {
            vscode.window.showInformationMessage(MSG.NO_CONTENT);
            return;
          }
          const cfg = getConfig();
          const fmt = cfg.get<string>(
            "postTitleFormat",
            "오늘 한 일 ({{date}})",
          );
          const formatted = formatAsBlogPost(content, fmt);
          webview.postMessage({ type: "formatted", content: formatted });
          break;
        }
        case "openInEditor": {
          const text = (msg.content || "").trim();
          if (!text) {
            vscode.window.showInformationMessage(MSG.NO_CONTENT);
            return;
          }
          const doc = await vscode.workspace.openTextDocument({
            content: text,
            language: "markdown",
          });
          await vscode.window.showTextDocument(doc, { preview: false });
          break;
        }
        case "copyToClipboard": {
          const text = msg.content || "";
          if (text) {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage("클립보드에 복사했어요.");
          } else {
            vscode.window.showInformationMessage(MSG.NO_CONTENT);
          }
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
    }
  });
}

export class BlogViewProvider implements vscode.WebviewViewProvider {
  constructor(private _context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = getWebviewHtml();
    setupWebviewMessageHandler(webviewView.webview, this._context);
  }
}

export function registerBlogView(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      new BlogViewProvider(context),
    ),
  );
}

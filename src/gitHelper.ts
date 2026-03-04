import * as vscode from 'vscode';
import { execSync } from 'child_process';

export function getWorkspaceRoot(): string | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  return folder.uri.fsPath;
}

/** 로컬 브랜치 목록 (현재 브랜치에는 *) */
export function getBranches(workspaceRoot: string): string[] {
  try {
    const out = execSync('git branch --no-color', {
      cwd: workspaceRoot,
      encoding: 'utf-8',
    });
    return out
      .split('\n')
      .map((line) => line.replace(/^\*?\s*/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface CommitFileStat {
  path: string;
  add: number;
  del: number;
}

/** 날짜 범위 (ISO 날짜 문자열) */
export interface DateRange {
  since: string;
  until?: string;
}

/** 오늘 / 어제 / 지난 7일 / 커스텀 */
export function getDateRangeForPreset(
  preset: 'today' | 'yesterday' | 'last7' | 'custom',
  customSince?: string,
  customUntil?: string
): DateRange {
  if (preset === 'custom' && customSince) {
    return { since: customSince, until: customUntil };
  }
  const now = new Date();
  const toStart = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.toISOString().slice(0, 10);
  };
  if (preset === 'today') {
    return { since: toStart(now) };
  }
  if (preset === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { since: toStart(y), until: toStart(y) };
  }
  if (preset === 'last7') {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { since: toStart(from), until: toStart(now) };
  }
  return { since: toStart(now) };
}

/** diff 옵션 (설정에서 주입) */
export interface DiffOptions {
  maxLinesPerCommit: number;
  maxLinesPerFile: number;
  includeExtensions: RegExp;
  skipPatterns: RegExp;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  /** 변경 파일 목록 (추가/삭제 줄 수). numstat 있으면 채워짐 */
  files?: CommitFileStat[];
  /** 핵심 코드 변경(diff 일부). includeDiff 시 채워짐 */
  diff?: string;
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/** 해당 브랜치의 지정 기간 커밋 목록 (해시·제목·본문만) */
function getCommitsInRange(
  workspaceRoot: string,
  branch: string,
  dateRange: DateRange
): CommitInfo[] {
  try {
    const sinceStr = `${dateRange.since}T00:00:00`;
    const untilArg = dateRange.until
      ? ` --until=${dateRange.until}T23:59:59`
      : '';
    const out = execSync(
      `git log ${branch} --since=${sinceStr}${untilArg} --pretty=format:"%h%x00%s%x00%b%x00"`,
      { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 1024 * 1024 }
    );
    if (!out.trim()) return [];
    const parts = out.split('\0').filter(Boolean);
    const commits: CommitInfo[] = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      commits.push({
        hash: parts[i].trim(),
        subject: parts[i + 1].trim(),
        body: parts[i + 2].trim().replace(/\n+/g, ' '),
      });
    }
    return commits;
  } catch {
    return [];
  }
}

/** 특정 커밋의 변경 파일 통계 (추가/삭제 줄 수) */
export function getCommitFileStats(
  workspaceRoot: string,
  hash: string
): CommitFileStat[] {
  try {
    const out = execSync(`git show ${hash} --numstat`, {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      maxBuffer: 512 * 1024,
    });
    const lines = out.split(/\r?\n/).filter(Boolean);
    const files: CommitFileStat[] = [];
    for (const line of lines) {
      const m = line.match(NUMSTAT_LINE);
      if (m) {
        files.push({
          path: m[3].trim(),
          add: m[1] === '-' ? 0 : parseInt(m[1], 10),
          del: m[2] === '-' ? 0 : parseInt(m[2], 10),
        });
      }
    }
    return files;
  } catch {
    return [];
  }
}

/** 기본 diff 옵션 (설정 없을 때) */
function getDefaultDiffOptions(): DiffOptions {
  return {
    maxLinesPerCommit: 120,
    maxLinesPerFile: 35,
    includeExtensions: /\.(tsx?|jsx?|css|html|vue|json)$/,
    skipPatterns: /package-lock\.json|\.lock$|node_modules|^dist\//i,
  };
}

/** 특정 커밋의 diff 일부 (옵션으로 필터·줄 수 제한) */
export function getCommitDiff(
  workspaceRoot: string,
  hash: string,
  options?: Partial<DiffOptions>
): string {
  const opts = { ...getDefaultDiffOptions(), ...options };
  try {
    const out = execSync(`git show ${hash} -p --no-stat`, {
      cwd: workspaceRoot,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
    const rawBlocks = out.split(/diff --git /).filter(Boolean);
    const lines: string[] = [];
    for (const raw of rawBlocks) {
      const block = 'diff --git ' + raw.trimStart();
      const firstLine = block.split(/\r?\n/)[0];
      const pathMatch = firstLine.match(/diff --git a\/(.+?) b\//);
      const path = pathMatch ? pathMatch[1] : '';
      if (opts.skipPatterns.test(path) || !opts.includeExtensions.test(path)) continue;
      const blockLines = block.split(/\r?\n/).slice(0, opts.maxLinesPerFile + 5);
      if (lines.length + blockLines.length > opts.maxLinesPerCommit) {
        lines.push('... (이하 생략)');
        break;
      }
      lines.push(...blockLines);
    }
    return lines.slice(0, opts.maxLinesPerCommit).join('\n').trim();
  } catch {
    return '';
  }
}

/** 해당 브랜치의 지정 기간 커밋 목록 + 통계 (+ 옵션으로 핵심 diff) */
export function getCommitsWithStatsInRange(
  workspaceRoot: string,
  branch: string,
  dateRange: DateRange,
  options?: { includeDiff?: boolean; diffOptions?: Partial<DiffOptions> }
): CommitInfo[] {
  const commits = getCommitsInRange(workspaceRoot, branch, dateRange);
  return commits.map((c) => {
    const files = getCommitFileStats(workspaceRoot, c.hash);
    let diff: string | undefined;
    if (options?.includeDiff) {
      const d = getCommitDiff(workspaceRoot, c.hash, options.diffOptions);
      if (d) diff = d;
    }
    return { ...c, files: files.length ? files : undefined, diff };
  });
}

/** 여러 브랜치·기간에 대해 커밋+변경통계 수집 */
export function getCommitsForBranchesInRange(
  workspaceRoot: string,
  branches: string[],
  dateRange: DateRange,
  options?: { includeDiff?: boolean; diffOptions?: Partial<DiffOptions> }
): { branch: string; commits: CommitInfo[] }[] {
  return branches.map((branch) => ({
    branch,
    commits: getCommitsWithStatsInRange(workspaceRoot, branch, dateRange, options),
  }));
}

/** 커밋 ID(해시) 하나로 해당 커밋 상세 조회. 없으면 null */
export function getSingleCommitInfo(
  workspaceRoot: string,
  hash: string,
  options?: { includeDiff?: boolean; diffOptions?: Partial<DiffOptions> }
): CommitInfo | null {
  const trimmed = hash.trim();
  if (!trimmed) return null;
  try {
    const out = execSync(
      `git log -1 ${trimmed} --pretty=format:"%h%x00%s%x00%b"`,
      { cwd: workspaceRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 }
    );
    const parts = out.split('\0');
    const subject = parts[1]?.trim() ?? '';
    const body = (parts[2] ?? '').trim().replace(/\n+/g, ' ');
    const files = getCommitFileStats(workspaceRoot, trimmed);
    let diff: string | undefined;
    if (options?.includeDiff !== false) {
      const d = getCommitDiff(workspaceRoot, trimmed, options?.diffOptions);
      if (d) diff = d;
    }
    return {
      hash: parts[0]?.trim() ?? trimmed.slice(0, 7),
      subject,
      body,
      files: files.length ? files : undefined,
      diff,
    };
  } catch {
    return null;
  }
}

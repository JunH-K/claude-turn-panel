// 여는 명령 줄을 만들고 그 출력을 읽는다. 실행은 register.tsx가 한다.

/** cmux가 세션을 띄울 때 넣어 주는 환경변수. 없으면 cmux 밖이다. */
export const WORKSPACE_ENV = 'CMUX_WORKSPACE_ID'

export type Ran = { exitCode: number; stdout: string }

/** 지금 워크스페이스에 브라우저 칸을 새로 연다. 터미널 초점은 그대로 둔다 (R-15). */
export function openArgv(url: string): string[] {
  return ['cmux', 'browser', 'open', url, '--focus', 'false']
}

/** 이미 있는 브라우저 칸의 주소만 바꾼다 (R-15). */
export function navigateArgv(surface: string, url: string): string[] {
  return ['cmux', 'browser', '--surface', surface, 'navigate', url]
}

/** cmux는 성공하면 `OK …`, 실패하면 `Error: …`와 종료 코드 1을 낸다. */
export function isOk(ran: Ran | null): boolean {
  return ran !== null && ran.exitCode === 0 && /^OK\b/.test(ran.stdout.trim())
}

// 칸 이름은 다시 명령 인자로 들어간다. cmux가 내는 두 꼴(짧은 이름, UUID)만 받는다.
const SURFACE = /^(surface:\d{1,20}|[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})$/

export function isSurface(name: unknown): name is string {
  return typeof name === 'string' && SURFACE.test(name)
}

/** `OK surface=surface:12 pane=pane:3 placement=split`에서 칸 이름을 읽는다. */
export function openedSurface(ran: Ran | null): string | null {
  if (!isOk(ran)) {
    return null
  }
  const name = /\bsurface=(\S+)/.exec(ran?.stdout ?? '')?.[1]

  return isSurface(name) ? name : null
}

export const EDITORS = ['webstorm', 'vscode', 'cursor', 'system'] as const

export type Editor = (typeof EDITORS)[number]

export function isEditor(value: unknown): value is Editor {
  return typeof value === 'string' && (EDITORS as readonly string[]).includes(value)
}

/**
 * 파일을 편집기에서 여는 명령 줄 (R-15). 줄 번호가 있으면 그 줄로 연다.
 * 경로가 `-`로 시작하면 옵션으로 읽히므로 그런 경로는 받지 않는다(절대 경로만 넘어온다).
 */
export function editorArgv(editor: Editor, path: string, line: number | null): string[] | null {
  if (!path.startsWith('/')) {
    return null
  }
  if (editor === 'webstorm') {
    return line === null ? ['webstorm', path] : ['webstorm', '--line', String(line), path]
  }
  if (editor === 'vscode' || editor === 'cursor') {
    const command = editor === 'vscode' ? 'code' : 'cursor'

    return line === null ? [command, path] : [command, '--goto', `${path}:${line}`]
  }

  return textEditorArgv(path)
}

// 경로는 모델이 쓴 글에서 온다. `open <경로>`는 그 파일의 기본 앱으로 여는데, 스크립트나 앱이면 실행이 된다.
// `-t`는 무엇이든 기본 글 편집기로 열어 읽기만 하게 한다.
function textEditorArgv(path: string): string[] {
  return ['open', '-t', path]
}

/** 편집기 명령이 없을 때 쓰는 길: 맥의 기본 글 편집기로 연다. */
export function fallbackArgv(path: string): string[] | null {
  return path.startsWith('/') ? textEditorArgv(path) : null
}

/**
 * 실제 경로(바로가기를 다 푼 것)가 세션 폴더 안에 있는가 (R-27).
 * IDE는 파일을 열 때 그 파일이 든 프로젝트의 설정(실행 구성, 작업, 확장)도 함께 불러온다.
 * 사용자가 이미 이 세션에서 다루는 폴더 안의 파일만 IDE로 열고, 밖의 파일은 글 편집기로만 연다.
 */
export function isInside(realPath: string, realRoot: string): boolean {
  const root = realRoot.replace(/\/+$/, '')

  return root !== '' && realPath.startsWith(`${root}/`)
}

/** 세션 폴더나 홈에서 그 경로까지 내려갈 마디들. */
export type Walk = { base: string; parts: string[] }

/**
 * 모델이 적은 경로를 사람이 누르기 전에 확인할 길 (R-14). 세션 폴더나 홈 폴더 안이고 `.`·`..` 마디가 없어야 한다.
 * `/net/<호스트>/…` 같은 경로는 들여다보기만 해도 맥이 그 호스트로 네트워크 마운트를 시도한다.
 * 부르는 쪽은 이 마디들을 목록으로 하나씩 내려가며 바로가기를 만나면 멈춘다.
 */
export function walkOf(absolute: string, root: string, home: string): Walk | null {
  if (absolute.split('/').some(part => part === '.' || part === '..')) {
    return null
  }
  const base = isInside(absolute, root) ? root : isInside(absolute, home) ? home : null
  if (base === null) {
    return null
  }
  const trimmed = base.replace(/\/+$/, '')
  const parts = absolute.slice(trimmed.length + 1).split('/').filter(part => part !== '')

  return parts.length === 0 ? null : { base: trimmed, parts }
}

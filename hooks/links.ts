import type { FoundPaths } from '../types'

const MAX_URL = 2048
const MAX_PATHS = 60

/**
 * 브라우저 칸에 넘겨도 되는 주소면 그 주소를, 아니면 null을 돌려준다.
 * 주소는 모델이 쓴 글에서 나오므로 여는 쪽이 직접 검사한다: http(s)만, 공백·제어 문자·역슬래시 없이,
 * 호스트가 있고 계정 정보(`user@host`, 엉뚱한 호스트를 그럴듯하게 보이게 한다)가 없어야 한다.
 *
 * 돌려주는 것은 받은 글이 아니라 검사한 파서가 다시 쓴 주소다. 받은 글을 그대로 넘기면
 * 여는 쪽의 파서가 같은 글을 다르게 읽을 수 있다(역슬래시, 한글 호스트, 퍼센트 부호 등).
 * 다시 쓴 주소는 ASCII로만 되어 있어 어느 파서가 읽어도 같은 곳을 가리킨다.
 */
export function safeUrl(raw: string): string | null {
  if (raw.length > MAX_URL || !/^https?:\/\/[^\s\p{C}\\]+$/iu.test(raw)) {
    return null
  }
  try {
    const parsed = new URL(raw)
    const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    const isPlainHost = /^[a-z0-9.\-[\]:]+$/.test(parsed.hostname)
    const isAnonymous = parsed.username === '' && parsed.password === ''
    const { href } = parsed

    return isWeb && isPlainHost && isAnonymous && /^[\x21-\x7e]+$/.test(href) && href.length <= MAX_URL ? href : null
  } catch {
    return null
  }
}

/**
 * 주소를 목록에 보일 길이로 줄인다: 앞의 https://와 끝의 /를 떼고, 길면 경로의 가운데를 줄인다.
 * 호스트는 줄이지 않는다. `github.com.…attacker.io`처럼 진짜 호스트가 줄임표 속으로 숨지 않게 한다.
 */
export function shortUrl(url: string, max: number = 56): string {
  const bare = url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (bare.length <= max) {
    return bare
  }
  const cut = bare.search(/[/?#]/)
  const host = cut < 0 ? bare : bare.slice(0, cut)
  const rest = cut < 0 ? '' : bare.slice(cut)
  const room = max - host.length - 1
  if (room < 8) {
    return rest === '' ? host : `${host}/…`
  }
  const head = Math.ceil(room / 2)

  return `${host}${rest.slice(0, head)}…${rest.slice(rest.length - (room - head))}`
}

/** `git remote get-url origin`의 출력에서 GitHub 저장소 `owner/repo`를 읽는다. GitHub가 아니면 null (R-14). */
export function repoOf(remote: string): string | null {
  const found = /^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    remote.trim(),
  )

  return found === null ? null : `${found[1]}/${found[2]}`
}

// 파일 링크는 `file://` 주소에 줄 번호를 `#L42`로 붙인다.
export function fileHref(path: string, line: number | null): string {
  const encoded = path
    .split('/')
    .map(part => encodeURIComponent(part).replace(/[()!'*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')

  return `file://${encoded}${line === null ? '' : `#L${line}`}`
}

export type FileTarget = { path: string; line: number | null }

/** 파일 링크의 주소에서 경로와 줄 번호를 읽는다. 파일 링크가 아니면 null. */
export function parseFileHref(href: string): FileTarget | null {
  const found = /^file:\/\/(?:localhost)?(\/[^#?]*)(?:#L(\d{1,7}))?$/.exec(href)
  if (found === null) {
    return null
  }
  try {
    const path = decodeURIComponent(found[1] ?? '')
    // 경로는 다시 명령 인자로 들어간다. 제어 문자가 든 경로는 받지 않는다.
    if (path === '' || /\p{C}/u.test(path)) {
      return null
    }

    return { path, line: found[2] === undefined ? null : Number(found[2]) }
  } catch {
    return null
  }
}

/** 맨 주소 끝에 붙은 문장부호와 짝이 안 맞는 닫는 괄호를 뗀다. */
function trimBare(url: string): string {
  let out = url
  for (;;) {
    const lastChar = out.at(-1) ?? ''
    const isUnpairedParen = lastChar === ')' && out.split('(').length <= out.split(')').length - 1
    const isUnpairedBracket = lastChar === ']' && out.split('[').length <= out.split(']').length - 1
    if (!/[.,;:!?'"*_]/.test(lastChar) && !isUnpairedParen && !isUnpairedBracket) {
      return out
    }
    out = out.slice(0, -1)
  }
}

// 주소에 쓰이는 ASCII 글자. 한글을 받지 않아 뒤에 붙은 조사가 딸려 오지 않는다.
const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%"
// `http` 없이 쓴 글자를 주소로 볼 최상위 도메인. `sh`·`so`·`app`·`dev`·`me`처럼 파일 확장자와 겹치는 것은
// 경로가 붙었거나 `www.`로 시작할 때만 주소로 본다. 아니면 `main.sh` 같은 파일 이름이 남의 주소가 된다.
const TLDS = 'com|org|net|io|dev|so|ai|app|kr|co|me|sh|gg|xyz'
const BARE_TLDS: ReadonlySet<string> = new Set(['com', 'org', 'net', 'io', 'kr'])
// 폴더가 하나 이상 있고 확장자로 끝나는 경로. 앞머리는 `~/`, `./`, `../`, `/` 중 하나이거나 없다.
const PATH_BODY = '(?:~\\/|\\.{1,2}\\/|\\/)?(?:[\\w.@+-]+\\/)+[\\w.@+-]*\\.[A-Za-z0-9]{1,8}'
const LINE_TAIL = '(?::(\\d{1,7})(?::\\d{1,5})?)?'
const CODE_PATH = new RegExp(`^(${PATH_BODY})${LINE_TAIL}$`)
// 이보다 긴 줄은 훑지 않는다. 아래 패턴은 한 줄 안에서 줄 길이의 제곱까지 느려질 수 있다.
const MAX_LINE = 4000

// 순서가 뜻을 정한다: 이미 링크인 것과 코드는 먼저 잡아 그대로 두고, 주소 → 저장소#번호 → 주소 꼴 → #번호 → 경로 순이다.
// 이미 링크인 것은 글에 대괄호 한 겹, 주소에 괄호 한 겹까지 받는다(`[see [1]](…)`, `…/A_(b))`).
const TOKEN = new RegExp(
  [
    '(?<md>!?\\[(?:[^\\[\\]\\n]|\\[[^\\[\\]\\n]*\\])*\\]\\((?<dest>(?:[^()\\n]|\\([^()\\n]*\\))*)\\))',
    '(?<auto><[A-Za-z][A-Za-z0-9+.-]{0,30}:[^>\\s]*>)',
    '(?<code>``[^\\n]*?``|`[^`\\n]+`)',
    `(?<url>https?:\\/\\/[${URL_CHARS}]+)`,
    '(?<![\\w/.-])(?<slug>[A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+)#(?<slugNo>[1-9]\\d{0,6})(?![\\w#])',
    `(?<![\\w@/.:-])(?<host>(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:${TLDS})(?![\\w-])(?!\\.[A-Za-z0-9])(?:\\/[${URL_CHARS}]*)?)`,
    '(?<![\\w&#/])#(?<no>[1-9]\\d{0,6})(?![\\w#])',
    `(?<![\\w/.~@#:+-])(?<path>${PATH_BODY})(?::(?<line>\\d{1,7})(?::\\d{1,5})?)?(?![\\w/])`,
  ].join('|'),
  'g',
)

// 울타리 코드블록을 여는 줄. 목록이나 인용 안에 들여 쓴 것도 받는다.
const FENCE_LINE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/
// 참조 링크의 정의 줄(`[1]: https://…`).
const REFERENCE_LINE = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*/
// 이미 링크인 것의 글 부분.
const MD_LABEL = /^!?\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(/

// 링크 글을 링크 밖의 글로 둘 때 쓴다. 안의 대괄호·꺾쇠가 다시 링크가 되지 않게 글자로 만든다.
function plainLabel(label: string): string {
  return label.replace(/[\\[\]<]/g, '\\$&')
}

// 링크 글이 그 주소를 그대로 적은 것인가 (앞의 http(s)://와 끝의 /는 보지 않는다).
function sameAddress(label: string, url: string): boolean {
  const bare = (value: string): string => value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()

  return label.trim() !== '' && bare(label) === bare(url)
}

function isWeb(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

type Piece =
  | { kind: 'text'; raw: string }
  /** 모델이 직접 쓴 링크. 누르는 글자를 실제 주소로 다시 쓴다 */
  | { kind: 'named'; label: string; url: string }
  | { kind: 'web'; raw: string; url: string }
  | { kind: 'issue'; raw: string; repo: string | null; number: string }
  | { kind: 'path'; raw: string; path: string; line: number | null }

// `http` 없이 쓴 글자를 주소로 볼 것인가.
function isAddress(bare: string): boolean {
  const host = (bare.split('/')[0] ?? '').toLowerCase()

  return bare.includes('/') || host.startsWith('www.') || BARE_TLDS.has(host.slice(host.lastIndexOf('.') + 1))
}

// 코드블록 밖의 한 줄을 조각으로 나눈다.
function scanLine(line: string, pieces: Piece[]): void {
  let at = 0
  for (const found of line.matchAll(TOKEN)) {
    const groups = found.groups ?? {}
    const raw = found[0]
    if (found.index > at) {
      pieces.push({ kind: 'text', raw: line.slice(at, found.index) })
    }
    at = found.index + raw.length
    if (groups.md !== undefined) {
      // 모델이 직접 쓴 링크와 그림. 주소 뒤의 제목(`"…"`)은 뗀다.
      const href = (groups.dest ?? '').trim().replace(/^<|>$/g, '').split(/\s/)[0] ?? ''
      const label = MD_LABEL.exec(raw)?.[1] ?? ''
      // 검사를 통과한 웹 주소만 링크로 다시 쓴다. `file:` 같은 링크는 cmd+클릭하면 기본 앱이 열므로 글로 푼다 (R-25).
      const url = isWeb(href) ? safeUrl(href) : null
      pieces.push(url === null ? { kind: 'text', raw: plainLabel(label) } : { kind: 'named', label, url })
    } else if (groups.auto !== undefined) {
      const href = raw.slice(1, -1)
      const url = isWeb(href) ? safeUrl(href) : null
      pieces.push(url === null ? { kind: 'text', raw: `\\${raw}` } : { kind: 'web', raw: href, url })
    } else if (groups.code !== undefined) {
      const inner = CODE_PATH.exec(raw.replace(/^`+|`+$/g, '').trim())
      pieces.push(
        inner === null
          ? { kind: 'text', raw }
          : { kind: 'path', raw, path: inner[1] ?? '', line: inner[2] === undefined ? null : Number(inner[2]) },
      )
    } else if (groups.url !== undefined || groups.host !== undefined) {
      const bare = trimBare(raw)
      const url = groups.url === undefined && !isAddress(bare) ? null : safeUrl(groups.url !== undefined ? bare : `https://${bare}`)
      pieces.push(url === null ? { kind: 'text', raw: bare } : { kind: 'web', raw: bare, url })
      if (bare.length < raw.length) {
        pieces.push({ kind: 'text', raw: raw.slice(bare.length) })
      }
    } else if (groups.slug !== undefined) {
      pieces.push({ kind: 'issue', raw, repo: groups.slug, number: groups.slugNo ?? '' })
    } else if (groups.no !== undefined) {
      pieces.push({ kind: 'issue', raw, repo: null, number: groups.no })
    } else {
      pieces.push({ kind: 'path', raw, path: groups.path ?? '', line: groups.line === undefined ? null : Number(groups.line) })
    }
  }
  if (at < line.length) {
    pieces.push({ kind: 'text', raw: line.slice(at) })
  }
}

// 글을 조각으로 나눈다. 링크로 바꿀지는 부르는 쪽이 정한다.
// 울타리 코드블록 안, 참조 정의 줄, 너무 긴 줄은 훑지 않고 글자 그대로 둔다.
function scan(markdown: string): Piece[] {
  const pieces: Piece[] = []
  let fence: { mark: string; length: number } | null = null
  const lines = markdown.split('\n')
  lines.forEach((line, index) => {
    const end = index < lines.length - 1 ? '\n' : ''
    const found = FENCE_LINE.exec(line)
    const marks = found?.[1] ?? ''
    const rest = found?.[2] ?? ''
    if (fence !== null) {
      // 닫는 줄은 여는 줄과 같은 글자로, 같거나 더 길게, 뒤에 다른 글 없이 쓴다.
      if (marks.startsWith(fence.mark) && marks.length >= fence.length && rest.trim() === '') {
        fence = null
      }
      pieces.push({ kind: 'text', raw: line + end })

      return
    }
    // 백틱 울타리의 여는 줄에는 백틱이 더 나오지 않는다. 나오면 한 줄짜리 코드 글씨다.
    if (marks !== '' && !(marks.startsWith('`') && rest.includes('`'))) {
      fence = { mark: marks.charAt(0), length: marks.length }
      pieces.push({ kind: 'text', raw: line + end })

      return
    }
    if (line.length > MAX_LINE) {
      // 훑지 않는 줄도 링크가 되지 않게 링크를 여는 글자를 글자로 만든다 (R-13).
      pieces.push({ kind: 'text', raw: line.replace(/[[<]/g, '\\$&') + end })

      return
    }
    if (REFERENCE_LINE.test(line)) {
      // 참조 정의는 정의가 되지 않게 첫 대괄호를 글자로 만든다. `[믿을 만한 글][r]`이 다른 곳을 열지 못하게 한다 (R-13).
      pieces.push({ kind: 'text', raw: line.replace('[', '\\[') + end })

      return
    }
    scanLine(line, pieces)
    if (end !== '') {
      pieces.push({ kind: 'text', raw: end })
    }
  })

  return pieces
}

/** 보고 본문에 적힌 경로들. 실제로 있는 파일인지는 부르는 쪽이 확인한다 (R-14). */
export function pathCandidates(markdown: string): string[] {
  const seen = new Set<string>()
  for (const piece of scan(markdown)) {
    if (piece.kind === 'path' && seen.size < MAX_PATHS) {
      seen.add(piece.path)
    }
  }

  return [...seen]
}

/** 적힌 경로를 절대 경로로 편다. `..`은 풀지 않는다. 여는 쪽이 받은 그대로 넘긴다. */
export function absolutePath(path: string, cwd: string, home: string): string | null {
  if (path.startsWith('/')) {
    return path
  }
  if (path.startsWith('~/')) {
    return home === '' ? null : `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  }
  if (cwd === '') {
    return null
  }

  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}

export type LinkContext = {
  /** 세션 폴더의 GitHub 저장소. 없으면 `#123`에 링크를 걸지 않는다 */
  repo: string | null
  /** 실제로 있는 파일들: 적힌 경로 → 절대 경로 */
  paths: FoundPaths
}

export type Linked = {
  markdown: string
  /** 본문에 있는 http(s) 링크의 주소들, 마크다운에 적힌 그대로 */
  web: string[]
  /** 본문에 적힌, 실제로 있는 파일의 주소들. 본문에서는 링크로 걸지 않고 링크 상자의 단추로만 연다 */
  files: string[]
}

// 앞 글자가 주소 이름의 글자가 아닌 곳의 `file:`. 대소문자, 사이의 탭(주소 해석기가 지운다), `\\:`를 받는다.
const FILE_SCHEME = /(?<![A-Za-z0-9+.-])f\t*i\t*l\t*e\t*(?:\\\t*)?:/gi
// 문자 참조(`&#102;`, `&colon;`)의 시작. 링크 주소 안에서 글자로 풀려 `file:`을 만들 수 있다.
const CHARACTER_REFERENCE = /(\\*)&(?=#|[A-Za-z][A-Za-z0-9]*;)/g

/**
 * 글 전체에서 `file:` 주소가 만들어질 수 있는 글자 줄을 끊는다 (R-25).
 * 마크다운 문법을 따라가지 않는다. 링크·참조 정의·코드 울타리를 렌더러와 다르게 읽어도 빠져나갈 틈이 없게 한다.
 * 이 렌더러가 링크로 그리는 주소는 `http(s)`와 `file`뿐이라, `file:`만 끊으면 남는 링크는 웹 주소다.
 */
export function defuseFileLinks(markdown: string): string {
  return markdown
    .replace(CHARACTER_REFERENCE, (_, slashes: string) => `${slashes}${slashes.length % 2 === 0 ? '\\' : ''}&`)
    .replace(FILE_SCHEME, found => `${found.slice(0, found.lastIndexOf(':')).replace(/[\t\\]+$/, '')} :`)
}

function sameOwner(slug: string, repo: string | null): boolean {
  return repo !== null && (slug.split('/')[0] ?? '').toLowerCase() === (repo.split('/')[0] ?? '').toLowerCase()
}

function linkText(text: string): string {
  return text.replace(/([\\[\]*_`])/g, '\\$1')
}

function linkTarget(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/**
 * 보고 본문의 주소와 번호를 마크다운 링크로 바꾸고, 실제로 있는 파일의 경로를 모은다 (R-13, R-25).
 * 코드블록 안과 이미 링크인 것은 건드리지 않는다. 확인되지 않은 번호는 글자 그대로 둔다.
 *
 * 파일 경로는 본문에서 링크로 걸지 않는다. 본문 링크는 cmd+클릭하면 터미널이 파일의 기본 앱으로 여는데,
 * 스크립트나 실행기에 묶인 파일(바로가기로 이름만 바꾼 것 포함)이면 그대로 실행된다. 확장자로 거르는 것은
 * 우회할 길이 남으므로, 파일은 늘 편집기로 여는 링크 상자의 단추로만 연다.
 */
export function linkify(markdown: string, context: LinkContext): Linked {
  const web = new Set<string>()
  const files = new Set<string>()
  const out = scan(markdown).map(piece => {
    if (piece.kind === 'text') {
      return piece.raw
    }
    if (piece.kind === 'named') {
      // 글이 주소와 같으면 그대로 링크로, 다르면 `글 (실제 주소)`로 쓰고 괄호 안만 누를 수 있게 한다.
      // 보이는 글과 다른 곳을 여는 링크를 막는다 (R-13).
      const target = linkTarget(piece.url)
      web.add(target)
      const link = `[${linkText(shortUrl(piece.url))}](${target})`

      return sameAddress(piece.label, piece.url) ? link : `${plainLabel(piece.label)} (${link})`
    }
    if (piece.kind === 'web') {
      const target = linkTarget(piece.url)
      web.add(target)

      return `[${linkText(piece.raw)}](${target})`
    }
    if (piece.kind === 'issue') {
      // `owner/repo#N` 꼴은 세션 저장소와 같은 owner일 때만 건다. `and/or#1`이나 `feature/login#2` 같은
      // 글자가 남의 저장소 주소로 걸리지 않게 한다.
      const repo = piece.repo === null || sameOwner(piece.repo, context.repo) ? (piece.repo ?? context.repo) : null
      if (repo === null) {
        return piece.raw
      }
      const target = `https://github.com/${repo}/issues/${piece.number}`
      web.add(target)

      return `[${linkText(piece.raw)}](${target})`
    }
    const found = Object.hasOwn(context.paths, piece.path) ? context.paths[piece.path] : undefined
    if (found !== undefined) {
      files.add(fileHref(found, piece.line))
    }

    return piece.raw
  })

  return { markdown: defuseFileLinks(out.join('')), web: [...web], files: [...files] }
}

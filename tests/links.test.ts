import { expect, test } from 'claude-code/testing'

import { absolutePath, defuseFileLinks, fileHref, linkify, parseFileHref, pathCandidates, repoOf, safeUrl, shortUrl } from '../hooks/links'
import type { LinkContext } from '../hooks/links'
import { editorArgv, fallbackArgv, isEditor, isInside, isOk, openedSurface, walkOf } from '../hooks/open'

const NONE: LinkContext = { repo: null, paths: {} }
const REPO: LinkContext = { repo: 'acme/app', paths: {} }

test('맨 주소를 링크로 바꾸고, 끝에 붙은 문장부호와 한글 조사는 뗀다 (R-13)', () => {
  expect(linkify('문서는 https://example.com/docs/a 를 본다.', NONE).markdown).toBe(
    '문서는 [https://example.com/docs/a](https://example.com/docs/a) 를 본다.',
  )
  expect(linkify('여기(https://example.com/a).', NONE).markdown).toBe('여기([https://example.com/a](https://example.com/a)).')
  expect(linkify('https://example.com/a에서 본다', NONE).markdown).toBe('[https://example.com/a](https://example.com/a)에서 본다')
  expect(linkify('위키 https://en.wikipedia.org/wiki/A_(b) 참고', NONE).web).toEqual(['https://en.wikipedia.org/wiki/A_%28b%29'])
})

test('http 없이 쓴 주소 꼴 글자도 링크로 바꾼다 (R-13)', () => {
  expect(linkify('github.com/acme/app/pull/12 를 본다', NONE).markdown).toBe(
    '[github.com/acme/app/pull/12](https://github.com/acme/app/pull/12) 를 본다',
  )
  expect(linkify('www.example.com 과 notion.so/page-1', NONE).web).toEqual(['https://www.example.com/', 'https://notion.so/page-1'])
  expect(linkify('naver.co.kr', NONE).web).toEqual(['https://naver.co.kr/'])
  expect(linkify('www.example.dev', NONE).web).toEqual(['https://www.example.dev/'])
})

test('확장자와 겹치는 도메인은 경로가 붙었거나 www.로 시작할 때만 주소로 본다 (R-13)', () => {
  // 백틱 없이 쓴 파일 이름이 남의 주소가 되면 안 된다.
  for (const text of ['main.sh 를 실행한다', 'lib.so 를 올린다', 'Next.app 을 연다', 'config.dev 를 고친다', 'about.me', 'play.gg']) {
    expect(linkify(text, NONE)).toEqual({ markdown: text, web: [], files: [] })
  }
  expect(linkify('vercel.app/docs', NONE).web).toEqual(['https://vercel.app/docs'])
})

test('주소처럼 보여도 파일 이름·메일·버전은 링크로 바꾸지 않는다 (R-13)', () => {
  for (const text of ['README.md 를 고쳤다', 'index.d.ts', 'next.config.js', 'me@example.com 로 보낸다', 'styles.app.css', 'v1.2.3', 'Node.js']) {
    expect(linkify(text, NONE)).toEqual({ markdown: text, web: [], files: [] })
  }
})

test('#123은 저장소가 GitHub일 때만, owner/repo#123은 같은 owner일 때만 건다 (R-13, R-14)', () => {
  expect(linkify('PR #1234 를 본다', REPO).markdown).toBe('PR [#1234](https://github.com/acme/app/issues/1234) 를 본다')
  expect(linkify('PR #1234 를 본다', NONE).markdown).toBe('PR #1234 를 본다')
  expect(linkify('acme/lib#7 참고', REPO).markdown).toBe('[acme/lib#7](https://github.com/acme/lib/issues/7) 참고')
  expect(linkify('ACME/lib#7 참고', REPO).web).toEqual(['https://github.com/ACME/lib/issues/7'])
  // `단어/단어#N` 꼴의 글자가 남의 저장소 주소로 걸리면 안 된다.
  for (const text of ['and/or#1 을 본다', 'docs/README#3', 'feature/login#2 브랜치', 'other/lib#7 참고']) {
    expect(linkify(text, REPO).markdown).toBe(text)
    expect(linkify(text, NONE).markdown).toBe(text)
  }
})

test('번호처럼 보여도 제목 기호·색·0으로 시작하는 수는 걸지 않는다', () => {
  for (const text of ['# 1 제목', 'a#12', '색은 #0f0f0f', '#012', '#12ab']) {
    expect(linkify(text, REPO).markdown).toBe(text)
  }
  // 문자 참조는 링크가 되지 않고, `file:`을 숨기지 못하게 글자 그대로 보인다 (R-25).
  expect(linkify('&#39;', REPO)).toEqual({ markdown: '\\&#39;', web: [], files: [] })
})

test('실제로 있는 파일의 경로만 모은다. 줄 번호는 주소에 붙인다 (R-13, R-14)', () => {
  const context: LinkContext = { repo: null, paths: { 'src/auth/authClient.ts': '/work/app/src/auth/authClient.ts' } }
  const text = 'src/auth/authClient.ts:42 를 고쳤고 src/none/x.ts 는 없다.'
  const linked = linkify(text, context)

  expect(linked.files).toEqual(['file:///work/app/src/auth/authClient.ts#L42'])
  expect(linked.web).toEqual([])
  // 본문에서는 링크로 걸지 않는다 (R-25).
  expect(linked.markdown).toBe(text)
})

test('코드 글씨로 적힌 경로도 모은다. 다른 코드는 그대로 둔다 (R-13)', () => {
  const context: LinkContext = { repo: 'acme/app', paths: { 'src/a.ts': '/work/app/src/a.ts' } }
  const text = '`src/a.ts` 와 `npm run build` 와 `https://example.com` 와 `#12`'
  const linked = linkify(text, context)

  expect(linked.files).toEqual(['file:///work/app/src/a.ts'])
  expect(linked.markdown).toBe(text)
  expect(linked.web).toEqual([])
})

test('코드블록 안은 건드리지 않고, 모델이 쓴 링크는 실제 주소가 보이게 다시 쓴다 (R-13)', () => {
  const context: LinkContext = { repo: 'acme/app', paths: { 'src/a.ts': '/work/app/src/a.ts' } }
  const code = ['```bash', 'curl https://example.com/api #12 src/a.ts', '```'].join('\n')
  const text = ['[문서](https://example.com/docs) 와 <https://example.com/auto>', '', code, '', '![그림](https://example.com/a.png)'].join('\n')
  const linked = linkify(text, context)

  expect(linked.markdown).toBe(
    [
      '문서 ([example.com/docs](https://example.com/docs)) 와 [https://example.com/auto](https://example.com/auto)',
      '',
      code,
      '',
      '그림 ([example.com/a.png](https://example.com/a.png))',
    ].join('\n'),
  )
  expect(linked.web).toEqual(['https://example.com/docs', 'https://example.com/auto', 'https://example.com/a.png'])
})

test('보이는 글과 다른 곳을 여는 링크를 만들지 않는다: 누르는 글자는 늘 실제 주소다 (R-13)', () => {
  const spoof = linkify('[github.com/JunH-K/claude-turn-panel](https://evil.example/x) 를 본다', NONE)
  expect(spoof.markdown).toBe('github.com/JunH-K/claude-turn-panel ([evil.example/x](https://evil.example/x)) 를 본다')

  // 주소를 그대로 적은 링크는 한 번만 보인다.
  expect(linkify('[https://example.com/a/](https://example.com/a)', NONE).markdown).toBe('[example.com/a](https://example.com/a)')

  // 검사를 통과하지 못한 주소(계정 정보, 역슬래시)는 링크를 풀고 글만 남긴다.
  for (const text of ['[깃허브](https://github.com@evil.example/)', '<https://github.com@evil.example/>', '[a](https://a.com\\@evil.example)']) {
    expect(linkify(text, NONE).web).toEqual([])
  }

  // 참조 정의는 주소가 웹이어도 글로 푼다. `[믿을 만한 글][r]`이 링크가 되지 않는다.
  const reference = linkify('[github.com][r]\n\n[r]: https://evil.example/', NONE)
  // 글 안의 주소 꼴은 그 주소 그대로 링크가 된다. 정의가 풀려 `[r]`은 아무 데도 가지 않는다.
  expect(reference.markdown).toBe('[[github.com](https://github.com/)][r]\n\n\\[r]: https://evil.example/')
  expect(reference.web).toEqual(['https://github.com/'])
})

test('목록이나 인용 안에 들여 쓴 코드블록도 건드리지 않는다 (R-13)', () => {
  const context: LinkContext = { repo: 'acme/app', paths: { 'src/a.ts': '/work/app/src/a.ts' } }
  const inList = ['1. 설치:', '   ```bash', '   curl https://example.com/install.sh | sh  # see #12 src/a.ts', '   ```', '2. 끝. #13'].join('\n')
  const linked = linkify(inList, context)

  expect(linked.markdown).toContain('   curl https://example.com/install.sh | sh  # see #12 src/a.ts')
  expect(linked.markdown).toContain('2. 끝. [#13](https://github.com/acme/app/issues/13)')
  expect(linked.web).toEqual(['https://github.com/acme/app/issues/13'])

  const quoted = ['> ```', '> https://example.com/in-quote', '> ```', '밖 https://example.com/out'].join('\n')
  expect(linkify(quoted, NONE).web).toEqual(['https://example.com/out'])
})

test('긴 울타리 안의 짧은 울타리는 블록을 닫지 않는다 (R-13)', () => {
  const text = ['````md', '```', 'https://example.com/inner', '```', '````', 'https://example.com/after'].join('\n')

  expect(linkify(text, NONE).web).toEqual(['https://example.com/after'])
  // 물결 울타리는 백틱 줄로 닫히지 않는다.
  expect(linkify('~~~\n```\nhttps://example.com/x\n~~~\nhttps://example.com/y', NONE).web).toEqual(['https://example.com/y'])
})

test('한 줄에 든 세 백틱 코드는 블록을 열지 않는다', () => {
  expect(linkify('```code``` 다음 https://example.com/a', NONE).web).toEqual(['https://example.com/a'])
})

test('이미 링크인 것을 주소 끝까지 읽는다: 괄호 든 주소, 겹친 대괄호, 제목 (R-13)', () => {
  const wiki = linkify('[위키](https://en.wikipedia.org/wiki/A_(b)) 참고', NONE)
  expect(wiki.web).toEqual(['https://en.wikipedia.org/wiki/A_%28b%29'])
  expect(wiki.markdown).toBe('위키 ([en.wikipedia.org/wiki/A\\_(b)](https://en.wikipedia.org/wiki/A_%28b%29)) 참고')

  const nested = linkify('[see [1]](https://a.com/x) 참고', NONE)
  expect(nested).toEqual({ markdown: 'see \\[1\\] ([a.com/x](https://a.com/x)) 참고', web: ['https://a.com/x'], files: [] })

  const titled = '[문서](https://example.com/docs "제목")'
  expect(linkify(titled, NONE).web).toEqual(['https://example.com/docs'])
})

test('아주 긴 줄은 훑지 않고 그대로 둔다: 느려지지 않는다 (R-23)', () => {
  const long = `${'+'.repeat(80_000)} https://example.com/a`
  const before = Date.now()
  const linked = linkify(`${long}\n짧은 줄 https://example.com/b\n${'[x]('.repeat(20_000)}`, NONE)

  expect(Date.now() - before).toBeLessThan(500)
  expect(linked.web).toEqual(['https://example.com/b'])
  // 4천 자 안쪽의 까다로운 줄도 금방 끝난다.
  const tricky = Date.now()
  linkify(`${'+'.repeat(3900)}\n${'[x]('.repeat(900)}\n${'<a:'.repeat(1200)}`, NONE)
  expect(Date.now() - tricky).toBeLessThan(500)
})

test('닫히지 않은 코드블록은 끝까지 코드로 본다', () => {
  expect(linkify('글\n\n```\nhttps://example.com/a', NONE).markdown).toBe('글\n\n```\nhttps://example.com/a')
})

test('링크 글의 강조 기호는 그대로 보이게 막는다', () => {
  expect(linkify('https://example.com/a_b_c', NONE).markdown).toBe('[https://example.com/a\\_b\\_c](https://example.com/a_b_c)')
})

test('보고에 적힌 경로를 겹치지 않게 뽑는다 (R-14)', () => {
  const text = 'src/a.ts:3 과 `tests/b.test.ts` 와 ./c/d.json 과 ~/notes/e.md, 다시 src/a.ts\n\n```\nfenced/x.ts\n```\nhttps://example.com/p/q.html'

  expect(pathCandidates(text)).toEqual(['src/a.ts', 'tests/b.test.ts', './c/d.json', '~/notes/e.md'])
  // 폴더 없는 이름과 확장자 없는 경로는 뽑지 않는다.
  expect(pathCandidates('authClient.ts 와 src/auth 와 and/or')).toEqual([])
})

test('적힌 경로를 절대 경로로 편다', () => {
  expect(absolutePath('src/a.ts', '/work/app', '/home/me')).toBe('/work/app/src/a.ts')
  expect(absolutePath('./src/a.ts', '/work/app/', '/home/me')).toBe('/work/app/src/a.ts')
  expect(absolutePath('/etc/hosts.txt', '/work/app', '/home/me')).toBe('/etc/hosts.txt')
  expect(absolutePath('~/notes/e.md', '/work/app', '/home/me')).toBe('/home/me/notes/e.md')
  expect(absolutePath('~/notes/e.md', '/work/app', '')).toBeNull()
  expect(absolutePath('src/a.ts', '', '/home/me')).toBeNull()
})

test('파일 링크의 주소는 경로와 줄 번호로 되돌릴 수 있다 (R-15)', () => {
  for (const [path, line] of [
    ['/work/app/src/a.ts', 42],
    ['/work/내 문서/메모 (1).md', null],
    ['/work/app/app/[id]/page.tsx', 7],
  ] as const) {
    const href = fileHref(path, line)

    expect(href).toMatch(/^file:\/\/\/[\x21-\x7e]+$/)
    expect(href.includes('(') || href.includes(')')).toBe(false)
    expect(parseFileHref(href)).toEqual({ path, line })
  }
  expect(parseFileHref('https://example.com/a')).toBeNull()
  expect(parseFileHref('file://other-host/etc/passwd')).toBeNull()
  expect(parseFileHref('file:///a%00b')).toBeNull()
  expect(parseFileHref('file:///a%ZZ')).toBeNull()
})

test('git 원격 주소에서 GitHub 저장소를 읽는다 (R-14)', () => {
  expect(repoOf('git@github.com:acme/app.git\n')).toBe('acme/app')
  expect(repoOf('https://github.com/acme/app.git')).toBe('acme/app')
  expect(repoOf('https://github.com/acme/app')).toBe('acme/app')
  expect(repoOf('https://token@github.com/acme/my.app/')).toBe('acme/my.app')
  expect(repoOf('ssh://git@github.com/acme/app.git')).toBe('acme/app')
  expect(repoOf('git@gitlab.com:acme/app.git')).toBeNull()
  expect(repoOf('https://github.com.evil.example/acme/app')).toBeNull()
  expect(repoOf('')).toBeNull()
})

test('브라우저 칸에 넘길 주소는 http(s)이고 계정 정보가 없어야 한다 (R-15)', () => {
  expect(safeUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
  expect(safeUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/', 'https://exa mple.com', 'https://example.com\\@evil.com', '--help']) {
    expect(safeUrl(bad)).toBeNull()
  }
})

test('목록에 보일 주소는 앞머리를 떼고, 길면 가운데를 줄인다 (R-24)', () => {
  expect(shortUrl('https://example.com/docs/')).toBe('example.com/docs')
  expect(shortUrl(`https://example.com/${'a'.repeat(80)}/end`, 30)).toHaveLength(30)
  expect(shortUrl(`https://example.com/${'a'.repeat(80)}/end`, 30)).toContain('…')
  expect(shortUrl(`https://example.com/${'a'.repeat(80)}/end`, 30).endsWith('/end')).toBe(true)
})

test('목록의 짧은 주소는 호스트를 줄이지 않는다', () => {
  const tricky = 'https://github.com.JunH-K.claude-turn-panel.pull.attacker.io/acme/app/pull/12/files'
  const shown = shortUrl(tricky, 40)

  expect(shown.startsWith('github.com.JunH-K.claude-turn-panel.pull.attacker.io')).toBe(true)
})

test('본문에는 어떤 파일 링크도 만들지 않는다: cmd+클릭이 실행 파일을 열 길을 없앤다 (R-25)', () => {
  // 이름만 글 파일처럼 지은 바로가기(notes.md → 스크립트)도 있으므로 확장자로 거르지 않는다.
  const paths = { 'scripts/setup.command': '/w/scripts/setup.command', 'docs/notes.md': '/w/docs/notes.md', 'tools/run.py': '/w/tools/run.py' }
  const text = '`scripts/setup.command` 와 docs/notes.md 와 tools/run.py'
  const linked = linkify(text, { repo: null, paths })

  expect(linked.markdown).toBe(text)
  expect(linked.markdown).not.toContain('file://')
  // 모은 파일은 링크 상자의 단추로만 연다. 단추는 늘 편집기나 글 편집기로 연다.
  expect(linked.files).toEqual(['file:///w/scripts/setup.command', 'file:///w/docs/notes.md', 'file:///w/tools/run.py'])
})

test('편집기 명령 줄: 줄 번호가 있으면 그 줄로 연다 (R-15)', () => {
  expect(editorArgv('webstorm', '/work/app/a.ts', 42)).toEqual(['webstorm', '--line', '42', '/work/app/a.ts'])
  expect(editorArgv('webstorm', '/work/app/a.ts', null)).toEqual(['webstorm', '/work/app/a.ts'])
  expect(editorArgv('vscode', '/work/app/a.ts', 42)).toEqual(['code', '--goto', '/work/app/a.ts:42'])
  expect(editorArgv('cursor', '/work/app/a.ts', null)).toEqual(['cursor', '/work/app/a.ts'])
  // 기본 앱으로 여는 길은 글 편집기로만 연다. 스크립트나 앱이 실행되지 않는다.
  expect(editorArgv('system', '/work/app/run.command', 42)).toEqual(['open', '-t', '/work/app/run.command'])
  // 절대 경로가 아니면 옵션으로 읽힐 수 있어 받지 않는다.
  expect(editorArgv('webstorm', '--help', null)).toBeNull()
  expect(fallbackArgv('relative/a.ts')).toBeNull()
  expect(fallbackArgv('/work/app/a.ts')).toEqual(['open', '-t', '/work/app/a.ts'])
  expect(isEditor('vscode')).toBe(true)
  expect(isEditor('vim')).toBe(false)
  expect(isEditor(undefined)).toBe(false)
})

test('세션 폴더 안인지는 실제 경로로 판단한다 (R-27)', () => {
  expect(isInside('/work/app/src/a.ts', '/work/app')).toBe(true)
  expect(isInside('/work/app/src/a.ts', '/work/app/')).toBe(true)
  expect(isInside('/work/application/a.ts', '/work/app')).toBe(false)
  expect(isInside('/work/app', '/work/app')).toBe(false)
  expect(isInside('/etc/hosts', '')).toBe(false)
})

test('cmux의 답을 읽는다 (R-15)', () => {
  const ok = { exitCode: 0, stdout: 'OK surface=surface:12 pane=pane:3 placement=split\n' }

  expect(isOk(ok)).toBe(true)
  expect(isOk({ exitCode: 1, stdout: 'Error: nope' })).toBe(false)
  expect(isOk(null)).toBe(false)
  expect(openedSurface(ok)).toBe('surface:12')
  expect(openedSurface({ exitCode: 0, stdout: 'OK surface=--evil' })).toBeNull()
})

test('모델이 직접 쓴 http(s) 아닌 링크는 글로 푼다: 본문에 file: 링크가 남지 않는다 (R-13, R-25)', () => {
  const linked = linkify(
    [
      '[보기](file:///Applications/Calculator.app) 와 ![그림](https://a.com/i.png) 와 <file:///tmp/x.command>',
      '[보기2](<file:///tmp/a b.sh>) 와 [안쪽 [x](file:///tmp/y)](https://a.com/ok)',
      '[참고][r]',
      '[r]: file:///tmp/z.sh',
      '[w]: https://example.com/ok',
    ].join('\n'),
    NONE,
  )
  expect(linked.markdown).not.toMatch(/(?<!\\)\]\(file:|^\[r\]:|(?<!\\)<file:/m)
  expect(linked.markdown).toContain('보기 와 그림 ([a.com/i.png](https://a.com/i.png)) 와 \\<file :///tmp/x.command>')
  expect(linked.markdown).toContain('\\[r]: file :///tmp/z.sh')
  expect(linked.markdown).toContain('\\[w]: https://example.com/ok')
  expect(linked.web).toEqual(['https://a.com/i.png', 'https://a.com/ok'])
})

test('훑지 않는 긴 줄도 링크를 여는 글자를 글자로 만든다 (R-13)', () => {
  const long = `${'+'.repeat(5000)} [x](file:///tmp/a.sh) <file:///tmp/b>`
  expect(linkify(long, NONE).markdown.endsWith('\\[x](file :///tmp/a.sh) \\<file :///tmp/b>')).toBe(true)
})

test('세션 폴더나 홈 폴더 안의 경로만, 그 폴더에서 내려갈 마디로 나눈다 (R-14)', () => {
  expect(walkOf('/work/app/src/a.ts', '/work/app', '/home/me')).toEqual({ base: '/work/app', parts: ['src', 'a.ts'] })
  expect(walkOf('/home/me/notes/a.md', '/work/app/', '/home/me/')).toEqual({ base: '/home/me', parts: ['notes', 'a.md'] })
  expect(walkOf('/net/evil.example/a.ts', '/work/app', '/home/me')).toBeNull()
  expect(walkOf('/Volumes/share/a.ts', '/work/app', '/home/me')).toBeNull()
  expect(walkOf('/work/app/../../net/x/a.ts', '/work/app', '/home/me')).toBeNull()
  expect(walkOf('/work/app/./a.ts', '/work/app', '/home/me')).toBeNull()
  expect(walkOf('/home/me/a.ts', '', '')).toBeNull()
})

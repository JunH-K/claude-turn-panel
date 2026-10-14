import { expect, test } from 'claude-code/testing'

import { CWD, answer, ask, mountPane, turn, world } from './world'

const REPORT = [
  '토큰 만료 버그를 고쳤다.',
  '',
  '- 수정: `src/auth/authClient.ts:42`',
  '- 관련: PR #1234, https://example.com/docs',
  '',
  '```next',
  '실기기 확인 | 테스트만 돌렸고 실기기는 보지 않았다 => 시뮬레이터에서 확인해줘',
  '커밋하기 | 고친 파일이 커밋되지 않았다 => 방금 고친 것을 커밋해줘',
  '리뷰 | 변경이 인증 흐름을 건드린다 => /review 12',
  '```',
].join('\n')

test('턴이 끝나면 요청·보고·제안이 한 묶음으로 보인다 (R-2, R-3, R-9)', async ($, on) => {
  const seen = await world($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    await turn($, `로그인 버그 고쳐줘 ${surface}`, REPORT, 134_000)
    const pane = await mountPane($, surface)

    expect(await pane.find({ type: 'Text', text: `로그인 버그 고쳐줘 ${surface}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '✓ 완료' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: ' · 방금 · 2분 14초' })).toBeDefined()
    // 제안 블록은 보고 본문에 없다.
    expect((await pane.find({ type: 'Markdown' }))?.props.text).not.toContain('```next')
    expect((await pane.find({ key: 'next:0' }))?.props.hotkey).toBe('1')
    expect((await pane.find({ key: 'next:0' }))?.text).toContain('실기기 확인')
    expect(await pane.find({ type: 'Text', text: '근거 · 테스트만 돌렸고 실기기는 보지 않았다' })).toBeDefined()
    // 보낼 글을 그대로 보인다. 문구만 보고 고르면 문구와 다른 글이 나갈 수 있다 (R-11).
    expect(await pane.find({ type: 'Text', text: '보냄 · 시뮬레이터에서 확인해줘' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '명령 · /review 12  (누르면 입력란에 채운다)' })).toBeDefined()
    expect((await pane.find({ key: 'next:2' }))?.props.hotkey).toBe('3')
    expect(await pane.find({ key: 'next:3' })).toBeUndefined()
    await pane.unmount()
  }
  // 첫 턴이 시작할 때 한 번 열리고, 놓여 있는 동안에는 다시 열지 않는다 (R-20).
  expect(seen.opened).toBe(1)
})

test('엔터로 나눠 쓴 요청은 줄마다 그리고, 이어진 빈 줄은 하나로 줄인다 (R-4)', async ($, on) => {
  await world($, on)
  await turn($, '첫 줄\n\n\n둘째 줄\n셋째 줄', '끝.')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '첫 줄' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '둘째 줄' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '셋째 줄' })).toBeDefined()
  // 빈 줄은 하나만 남는다.
  expect((await pane.findAll({ type: 'Text' })).filter(one => one.text === ' ')).toHaveLength(1)
})

test('지난 시간은 시계가 가면 따라 바뀐다 (R-5)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '요청', '끝.', 5000)
  await seen.clock.advance(200_000)
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: ' · 3분 전 · 5초' })).toBeDefined()
})

test('도는 동안 진행 한 줄과 체크리스트를 보이고, 직전 보고는 흐리게 남긴다 (R-6, R-7)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '첫 요청', `첫 보고.\n\n\`\`\`next\n다음 | 근거 => 다음 일 해줘\n\`\`\``)
  const turnId = await ask($, '둘째 요청')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '둘째 요청' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '⏵ 진행 중 · 0초' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '생각하는 중' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '직전 보고' })).toBeDefined()
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('첫 보고.')
  // 도는 동안에는 제안을 숨긴다.
  expect(await pane.find({ key: 'next:0' })).toBeUndefined()

  // 시계가 가면 경과 시간이 따라간다.
  await seen.clock.advance(72_000)
  expect(await pane.find({ type: 'Text', text: '⏵ 진행 중 · 1분 12초' })).toBeDefined()

  seen.toolResults.TaskCreate = { task: { id: '1', subject: '원인 찾기' } }
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'c1', subject: '원인 찾기', description: '…' })
  seen.toolResults.TaskUpdate = { success: true, taskId: '1', updatedFields: ['status'] }
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'c2', taskId: '1', status: 'in_progress' })
  expect(await pane.find({ type: 'Text', text: /원인 찾기/ })).toBeDefined()

  await answer($, turnId, '둘째 보고.')
  expect(await pane.find({ type: 'Text', text: '직전 보고' })).toBeUndefined()
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('둘째 보고.')
})

test('도구가 도는 동안 그 일을 한 줄로 보이고, 끝나면 지운다 (R-6)', async ($, on) => {
  const seen = await world($, on)
  await ask($, '요청')
  const pane = await mountPane($)
  let during: string | undefined
  // 바닥 훅이 답하는 순간이 도구가 도는 중이다. 그때의 패널을 읽는다.
  seen.onTool = async () => {
    during = (await pane.find({ type: 'Text', text: /파일 읽는 중/ }))?.text
  }
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${CWD}/src/auth/authClient.ts` })

  expect(during).toContain('파일 읽는 중')
  expect(during).toContain('authClient.ts')
  expect(await pane.find({ type: 'Text', text: /파일 읽는 중/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '생각하는 중' })).toBeDefined()
  expect(seen.toasts).toEqual([])
})

test('하위 에이전트의 턴과 진행은 패널을 바꾸지 않는다. 고친 파일만 모은다 (R-1, R-8)', async ($, on) => {
  await world($, on)
  await turn($, '본 세션 요청', '본 세션 보고')
  const turnId = await ask($, '둘째 요청')
  // 테스트의 호출 타입에는 agentId 칸이 없다. 엔진은 하위 에이전트의 호출에 이 값을 붙여 보낸다.
  const fromWorker = { tool: 'Edit', tool_use_id: 'w1', agentId: 'agent-1', file_path: `${CWD}/worker.ts`, old_string: 'a', new_string: 'b' }
  await $.tool.call(fromWorker as never)
  await $.turn.complete({ answer: '워커 보고', durationMs: 10, isAborted: false, turnId: 'worker-1', reason: 'answer', agentId: 'agent-1' })
  await answer($, turnId, '둘째 보고')
  const pane = await mountPane($)

  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('둘째 보고')
  // 일을 하위 에이전트에 맡기는 구성에서도 무엇이 바뀌었는지는 보여야 한다.
  expect((await pane.find({ key: 'file:0' }))?.text).toBe('worker.ts')
  expect(await pane.find({ type: 'Text', text: '턴 2/2' })).toBeDefined()
})

test('엔진이 넣은 글은 요청으로 치지 않는다 (R-1)', async ($, on) => {
  await world($, on)
  await turn($, '에이전트를 띄워 세어줘', '띄웠다. 기다린다.')
  await $.prompt.submit({ text: '<task-notification>끝</task-notification>', origin: { kind: 'task-notification' }, wait: false })
  await $.turn.start({ text: '<task-notification>끝</task-notification>', turnId: 'follow-up' })
  await $.turn.complete({ answer: '파일은 5개다.', durationMs: 10, isAborted: false, turnId: 'follow-up', reason: 'answer' })
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '에이전트를 띄워 세어줘' })).toBeDefined()
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('파일은 5개다.')
})

test('고치거나 만든 파일을 바뀐 파일 상자에 보이고, 누르면 편집기로 연다 (R-8, R-15)', async ($, on) => {
  const seen = await world($, on)
  const turnId = await ask($, '고쳐줘')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  seen.toolResults.Write = { type: 'create', filePath: `${CWD}/src/new.ts` }
  await $.tool.call({ tool: 'Write', tool_use_id: 'e2', file_path: `${CWD}/src/new.ts`, content: 'x' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: `${CWD}/src/a.ts`, old_string: 'b', new_string: 'c' })
  // 실패한 호출은 적지 않는다.
  seen.onTool = call => (call.id === 'e4' ? { deny: '실패' } : undefined)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e4', file_path: `${CWD}/src/fail.ts`, old_string: 'a', new_string: 'b' })
  await answer($, turnId, '고쳤다.')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '바뀐 파일 (2)' })).toBeDefined()
  expect((await pane.find({ key: 'file:0' }))?.text).toBe('src/a.ts')
  expect((await pane.find({ key: 'file:1' }))?.text).toBe('src/new.ts  새 파일')
  expect(await pane.find({ key: 'file:2' })).toBeUndefined()

  seen.files.add(`${CWD}/src/new.ts`)
  await pane.press({ key: 'file:1' })
  expect(seen.calls.at(-1)).toEqual(['webstorm', `${CWD}/src/new.ts`])
})

test('세션 폴더 밖의 파일은 IDE가 아니라 글 편집기로만 연다 (R-27)', async ($, on) => {
  const seen = await world($, on)
  seen.files.add('/home/me/elsewhere/repo/main.ts')
  seen.files.add('/home/me/elsewhere/repo/secret.ts')
  // 세션 폴더 안의 이름이지만 밖을 가리키는 바로가기다.
  seen.links[`${CWD}/docs/notes.ts`] = '/home/me/elsewhere/repo/secret.ts'
  await turn($, '봐줘', '참고: /home/me/elsewhere/repo/main.ts:3 과 docs/notes.ts')
  const pane = await mountPane($)

  expect((await pane.find({ key: 'link:0' }))?.text).toBe('/home/me/elsewhere/repo/main.ts:3')
  await pane.press({ key: 'link:0' })
  expect(seen.calls.at(-1)).toEqual(['open', '-t', '/home/me/elsewhere/repo/main.ts'])
  expect(seen.toasts.at(-1)).toContain('세션 폴더 밖의 파일')

  // 바로가기로 된 파일은 확인하지 않으므로 링크 상자에 나오지 않는다 (R-14).
  expect(await pane.find({ key: 'link:1' })).toBeUndefined()
  expect(seen.calls.some(call => call[0] === 'webstorm')).toBe(false)
})

test('세션 폴더와 홈 폴더 밖의 경로, `..`이 든 경로, 바로가기를 지나는 경로는 들여다보지 않는다 (R-14)', async ($, on) => {
  const seen = await world($, on)
  seen.files.add('/net/evil.example/share/a.ts')
  seen.files.add('/tmp/b.ts')
  seen.files.add(`${CWD}/src/e.ts`)
  // 받아 온 저장소에 심긴 바로가기: 확인하려고 따라가기만 해도 네트워크 마운트가 일어난다.
  seen.links[`${CWD}/src/mount.ts`] = '/net/evil.example/x.ts'
  seen.links[`${CWD}/shared/doc.ts`] = '/net/evil.example/y.ts'
  seen.links[`${CWD}/shared`] = '/net/evil.example'
  await turn($, '봐줘', '참고: /net/evil.example/share/a.ts, /tmp/b.ts, ../../net/evil.example/c.ts, src/./d.ts, src/mount.ts, shared/doc.ts, src/e.ts')
  const pane = await mountPane($)

  expect(seen.listed.every(dir => dir === CWD || dir.startsWith(`${CWD}/`))).toBe(true)
  expect(seen.listed).not.toContain(`${CWD}/shared`)
  expect(seen.statted.filter(path => path !== CWD)).toEqual([])
  expect((await pane.find({ key: 'link:0' }))?.text).toBe('src/e.ts')
  expect(await pane.find({ key: 'link:1' })).toBeUndefined()
})

test('없는 파일은 열지 않고 알린다 (R-23)', async ($, on) => {
  const seen = await world($, on)
  const turnId = await ask($, '고쳐줘')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${CWD}/src/gone.ts`, old_string: 'a', new_string: 'b' })
  await answer($, turnId, '고쳤다.')
  const pane = await mountPane($)

  await pane.press({ key: 'file:0' })
  expect(seen.calls.some(call => call[0] === 'webstorm' || call[0] === 'open')).toBe(false)
  expect(seen.toasts.at(-1)).toContain('파일이 없어 열지 않았다')
})

test('편집기 옵션을 따르고, 편집기 명령이 없으면 글 편집기로 연다 (R-15, R-23)', { options: { editor: 'vscode' } }, async ($, on) => {
  const seen = await world($, on)
  seen.files.add(`${CWD}/src/a.ts`)
  const turnId = await ask($, '고쳐줘')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  await answer($, turnId, '고쳤다.')
  const pane = await mountPane($)

  await pane.press({ key: 'file:0' })
  expect(seen.calls.at(-1)).toEqual(['code', `${CWD}/src/a.ts`])

  seen.missing.add('code')
  await pane.press({ key: 'file:0' })
  expect(seen.calls.at(-1)).toEqual(['open', '-t', `${CWD}/src/a.ts`])
  expect(seen.toasts).toEqual([])

  seen.missing.add('open')
  await pane.press({ key: 'file:0' })
  expect(seen.toasts.at(-1)).toContain('파일을 열지 못했다')
})

test('보고의 주소·번호·실제로 있는 경로를 링크로 그린다 (R-13, R-14)', async ($, on) => {
  const seen = await world($, on)
  seen.files.add(`${CWD}/src/auth/authClient.ts`)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)
  const report = await pane.find({ type: 'Markdown' })

  // 파일 경로는 본문에서 링크로 걸지 않고, 링크 상자의 단추로만 연다 (R-25).
  expect(report?.props.text).toContain('`src/auth/authClient.ts:42`')
  expect(report?.props.text).not.toContain('file://')
  expect(report?.props.text).toContain('[#1234](https://github.com/acme/app/issues/1234)')
  expect(report?.props.text).toContain('[https://example.com/docs](https://example.com/docs)')
  expect(report?.props.pressableLinks).toEqual(['https://github.com/acme/app/issues/1234', 'https://example.com/docs'])
  expect((await pane.find({ key: 'link:2' }))?.text).toBe('src/auth/authClient.ts:42')
})

test('보고의 링크를 링크 상자에 단추로 다시 늘어놓는다: 키보드로 여는 길이다 (R-24)', async ($, on) => {
  const seen = await world($, on)
  seen.files.add(`${CWD}/src/auth/authClient.ts`)
  const turnId = await ask($, '고쳐줘')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${CWD}/src/auth/authClient.ts`, old_string: 'a', new_string: 'b' })
  await answer($, turnId, `${REPORT.split('```next')[0]}\n전체는 src/auth/authClient.ts 를 본다.`)
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '링크 (3)' })).toBeDefined()
  expect((await pane.find({ key: 'link:0' }))?.text).toBe('github.com/acme/app/issues/1234')
  expect((await pane.find({ key: 'link:1' }))?.text).toBe('example.com/docs')
  // 줄 번호가 붙은 파일 링크는 적는다. 줄 번호 없이 적힌 같은 파일은 바뀐 파일 상자에 있으므로 적지 않는다.
  expect((await pane.find({ key: 'link:2' }))?.text).toBe('src/auth/authClient.ts:42')
  expect(await pane.find({ key: 'link:3' })).toBeUndefined()

  await pane.press({ key: 'link:1' })
  expect(seen.calls.at(-1)).toEqual(['cmux', 'browser', 'open', 'https://example.com/docs', '--focus', 'false'])
  await pane.press({ key: 'link:2' })
  expect(seen.calls.at(-1)).toEqual(['webstorm', '--line', '42', `${CWD}/src/auth/authClient.ts`])
})

test('cmux 밖에서 링크 상자의 단추는 기본 브라우저로 연다 (R-24)', async ($, on) => {
  const seen = await world($, on, { inCmux: false })
  await turn($, '요청', '문서는 https://example.com/docs 다.')
  const pane = await mountPane($)

  await pane.press({ key: 'link:0' })
  expect(seen.calls.at(-1)).toEqual(['open', 'https://example.com/docs'])
  expect(seen.toasts).toEqual([])

  seen.missing.add('open')
  await pane.press({ key: 'link:0' })
  expect(seen.toasts.at(-1)).toContain('링크를 열지 못했다')
})

test('링크가 없는 보고에는 링크 상자가 없다 (R-24)', async ($, on) => {
  await world($, on)
  await turn($, '요청', '링크 없는 보고')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: /^링크 \(/ })).toBeUndefined()
  expect(await pane.find({ key: 'link:0' })).toBeUndefined()
})

test('git 원격이 GitHub가 아니고 파일이 없으면 번호와 경로는 글자 그대로다 (R-14)', async ($, on) => {
  const seen = await world($, on)
  seen.remote = 'git@gitlab.com:acme/app.git'
  await turn($, '고쳐줘', REPORT)
  const text = (await (await mountPane($)).find({ type: 'Markdown' }))?.props.text

  expect(text).toContain('PR #1234,')
  expect(text).toContain('`src/auth/authClient.ts:42`')
  expect(text).not.toContain('file://')
  expect(text).not.toContain('github.com')
})

test('주소 링크는 cmux 브라우저 칸에서, 파일은 링크 상자의 단추로 편집기에서 연다 (R-15)', async ($, on) => {
  const seen = await world($, on)
  seen.files.add(`${CWD}/src/auth/authClient.ts`)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)

  await pane.press({ key: 'report', link: { href: 'https://example.com/docs' } })
  expect(seen.calls.at(-1)).toEqual(['cmux', 'browser', 'open', 'https://example.com/docs', '--focus', 'false'])
  // 이 세션이 연 칸이 있으면 그 칸의 주소만 바꾼다.
  await pane.press({ key: 'report', link: { href: 'https://github.com/acme/app/issues/1234' } })
  expect(seen.calls.at(-1)).toEqual(['cmux', 'browser', '--surface', 'surface:2', 'navigate', 'https://github.com/acme/app/issues/1234'])
  expect(seen.surfaces).toHaveLength(2)

  await pane.press({ key: 'link:2' })
  expect(seen.calls.at(-1)).toEqual(['webstorm', '--line', '42', `${CWD}/src/auth/authClient.ts`])
  expect(seen.toasts).toEqual([])
})

test('cmux 밖에서는 본문의 주소 링크를 가로채지 않는다 (R-15)', async ($, on) => {
  const seen = await world($, on, { inCmux: false })
  seen.files.add(`${CWD}/src/auth/authClient.ts`)
  await turn($, '고쳐줘', REPORT)
  const report = await (await mountPane($)).find({ type: 'Markdown' })

  expect(report?.props.pressableLinks).toBeUndefined()
  expect(report?.props.onLinkPress).toBeUndefined()
})

test('숫자 키는 그 제안을 사용자 요청으로 바로 낸다. 한 번 고르면 선택창을 감춘다 (R-11)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)

  await pane.press({ key: 'next:1' })
  expect(seen.submitted).toEqual(['방금 고친 것을 커밋해줘'])
  // 틀("플러그인이 보낸 글") 없이 사용자의 글로 낸다.
  expect(seen.asUser).toEqual(['방금 고친 것을 커밋해줘'])
  expect(await pane.find({ key: 'next:0' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '고른 제안: 커밋하기' })).toBeDefined()

  // 고른 제안이 다음 턴의 요청이 되고, 그 턴이 끝나면 선택창이 돌아온다.
  await $.turn.start({ text: '방금 고친 것을 커밋해줘', turnId: 'picked-turn' })
  await answer($, 'picked-turn', `커밋했다.\n\n\`\`\`next\n푸시 | 원격에 없다 => 푸시해줘\n\`\`\``)
  expect(await pane.find({ type: 'Text', text: '방금 고친 것을 커밋해줘' })).toBeDefined()
  expect((await pane.find({ key: 'next:0' }))?.text).toContain('푸시')
})

test('/로 시작하는 제안은 실행하지 않고 입력란에 채운다: Enter가 두 번째 확인이다 (R-11)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)

  await pane.press({ key: 'next:2' })
  expect(seen.ran).toEqual([])
  expect(seen.submitted).toEqual([])
  expect(seen.filled).toEqual(['/review 12'])
  expect(seen.toasts.at(-1)).toContain('Enter로 실행한다')

  // 내장 명령도 같다. 모델이 쓴 명령이 키 한 번에 돌지 않는다.
  await turn($, '다시', '끝.\n\n```next\n설치 | 근거 => /plugin install evil@x\n```')
  await pane.press({ key: 'next:0' })
  expect(seen.ran).toEqual([])
  expect(seen.filled.at(-1)).toBe('/plugin install evil@x')
})

test('e 뒤의 숫자는 보내지 않고 입력란에 채운다. 한 번 채우면 풀린다 (R-12)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)

  await pane.press({ key: 'edit' })
  expect(await pane.find({ type: 'Text', text: /고쳐서 보내기: 숫자를 누르면/ })).toBeDefined()
  await pane.press({ key: 'next:0' })

  expect(seen.filled).toEqual(['시뮬레이터에서 확인해줘'])
  expect(seen.submitted).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(await pane.find({ type: 'Text', text: /고쳐서 보내기: 숫자를 누르면/ })).toBeUndefined()
  // 채우기만 했으므로 선택창은 그대로다.
  expect(await pane.find({ key: 'next:0' })).toBeDefined()
})

test('p와 n으로 지난 턴을 넘겨 보고, 지난 턴에서는 제안을 숨긴다 (R-16)', async ($, on) => {
  await world($, on)
  await turn($, '요청 하나', '보고 하나.\n\n```next\n가 | 근거 => 가 해줘\n```')
  await turn($, '요청 둘', '보고 둘.\n\n```next\n나 | 근거 => 나 해줘\n```')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '턴 2/2' })).toBeDefined()
  await pane.press({ key: 'turn:prev' })
  expect(await pane.find({ type: 'Text', text: '턴 1/2' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '요청 하나' })).toBeDefined()
  expect(await pane.find({ key: 'next:0' })).toBeUndefined()
  // 지난 턴의 제안은 고를 수 없게 글로만 보인다. 대화 화면에서 가린 블록이 여기 남는다.
  expect(await pane.find({ type: 'Text', text: '다음 작업 (지난 턴이라 고르지 않는다)' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '· 가 — 가 해줘' })).toBeDefined()

  await pane.press({ key: 'turn:prev' })
  expect(await pane.find({ type: 'Text', text: '턴 1/2' })).toBeDefined()
  await pane.press({ key: 'turn:next' })
  expect(await pane.find({ type: 'Text', text: '턴 2/2' })).toBeDefined()
  expect((await pane.find({ key: 'next:0' }))?.text).toContain('나')

  // 지난 턴을 보다가 새 턴이 시작하면 최신으로 돌아온다.
  await pane.press({ key: 'turn:prev' })
  await ask($, '요청 셋')
  expect(await pane.find({ type: 'Text', text: '턴 3/3' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '요청 셋' })).toBeDefined()
})

test('중단된 턴은 상태만 바꾸고 직전 보고를 둔다 (R-5)', async ($, on) => {
  await world($, on)
  await turn($, '첫 요청', '첫 보고')
  const turnId = await ask($, '둘째 요청')
  await $.turn.complete({ answer: '쓰다 만 글', durationMs: 4000, isAborted: true, turnId, reason: 'aborted' })
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '둘째 요청' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '■ 중단됨' })).toBeDefined()
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('첫 보고')
  expect(await pane.find({ type: 'Text', text: '진행' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '턴 2/2' })).toBeDefined()
})

test('제안 블록이 없거나 어긋나면 제안 없음만 보인다 (R-23)', async ($, on) => {
  await world($, on)
  await turn($, '요청', '블록 없는 보고')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '제안 없음' })).toBeDefined()

  // 어긋난 블록은 가리지 않고 보고 본문에 그대로 보인다.
  await turn($, '요청', '보고.\n\n```next\n화살표 없는 줄\n```')
  expect(await pane.find({ type: 'Text', text: '제안 없음' })).toBeDefined()
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('보고.\n\n```next\n화살표 없는 줄\n```')
})

test('선택창에 들지 못한 제안이 있으면 그 수를 알린다 (R-9)', async ($, on) => {
  await world($, on)
  const lines = [1, 2, 3, 4].map(n => `문구${n} | 근거${n} => 요청${n}`)
  await turn($, '요청', `끝.\n\n\`\`\`next\n${lines.join('\n')}\n\`\`\``)
  const pane = await mountPane($)

  expect(await pane.find({ key: 'next:2' })).toBeDefined()
  expect(await pane.find({ key: 'next:3' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /제안 1개가 더 적혀 있다/ })).toBeDefined()
})

test('끝난 턴이 없으면 안내만 보인다', async ($, on) => {
  await world($, on)
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: /아직 끝난 턴이 없다/ })).toBeDefined()
  expect(await pane.find({ type: 'Markdown' })).toBeUndefined()
})

test('초점이 없으면 맨 아래에 초점 주는 키를 알린다 (R-17)', async ($, on) => {
  await world($, on)
  await turn($, '요청', '보고')
  const focused = await mountPane($, 'terminal', true)
  expect(await focused.find({ type: 'Text', text: /1~3 제안 보내기/ })).toBeDefined()
  await focused.unmount()

  const blurred = await mountPane($, 'terminal', false)
  expect(await blurred.find({ type: 'Text', text: /ctrl\+x tab으로 패널에 초점/ })).toBeDefined()
  expect((await blurred.find({ key: 'turn:prev' }))?.props.hotkey).toBe('p')
  expect((await blurred.find({ key: 'turn:next' }))?.props.hotkey).toBe('n')
  expect((await blurred.find({ key: 'edit' }))?.props.hotkey).toBe('e')
})

test('겹쳐 도는 호출: 뒤에 시작한 호출이 먼저 끝나도 아직 도는 호출을 보인다 (R-6)', async ($, on) => {
  const seen = await world($, on)
  await ask($, '요청')
  const pane = await mountPane($)
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  seen.onTool = async call => {
    if (call.tool === 'Bash') {
      await gate
    }
  }
  const bash = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm test', description: '테스트 실행' })
  await seen.clock.settle()
  expect(await pane.find({ type: 'Text', text: /명령 실행 중/ })).toBeDefined()

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${CWD}/a.ts` })
  // Read가 끝났어도 Bash는 아직 돈다.
  expect(await pane.find({ type: 'Text', text: /명령 실행 중/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '생각하는 중' })).toBeUndefined()

  release()
  await bash
  expect(await pane.find({ type: 'Text', text: '생각하는 중' })).toBeDefined()
})

test('도구 호출이 던져도 그 줄은 지운다 (R-6, R-23)', async ($, on) => {
  const seen = await world($, on)
  await ask($, '요청')
  const pane = await mountPane($)
  seen.onTool = () => {
    throw new Error('호출이 중단됐다')
  }
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: `${CWD}/a.ts` }).catch(() => undefined)

  expect(await pane.find({ type: 'Text', text: /파일 읽는 중/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '생각하는 중' })).toBeDefined()
})

test('한꺼번에 온 할 일 만들기가 서로의 줄을 지우지 않는다 (R-6)', async ($, on) => {
  const seen = await world($, on)
  await ask($, '요청')
  const pane = await mountPane($)
  seen.onTool = call => ({ result: { task: { id: call.id, subject: `할 일 ${call.id}` } } })
  await Promise.all(
    ['1', '2', '3'].map(id => $.tool.call({ tool: 'TaskCreate', tool_use_id: id, subject: `할 일 ${id}`, description: '…' })),
  )

  for (const id of ['1', '2', '3']) {
    expect(await pane.find({ type: 'Text', text: `○ 할 일 ${id}` })).toBeDefined()
  }
})

test('이 턴에서 할 일 도구를 쓰지 않았으면 앞선 턴의 체크리스트를 끌고 오지 않는다 (R-6)', async ($, on) => {
  const seen = await world($, on)
  const first = await ask($, '첫 요청')
  seen.toolResults.TaskCreate = { task: { id: '1', subject: '끝내지 못한 일' } }
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'c1', subject: '끝내지 못한 일', description: '…' })
  await answer($, first, '첫 보고')

  await ask($, '상관없는 둘째 요청')
  const pane = await mountPane($)
  expect(await pane.find({ type: 'Text', text: /끝내지 못한 일/ })).toBeUndefined()

  // 다시 할 일 도구를 쓰면 이어서 보인다.
  seen.toolResults.TaskUpdate = { success: true, taskId: '1', updatedFields: ['status'] }
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'c2', taskId: '1', status: 'in_progress' })
  expect(await pane.find({ type: 'Text', text: /끝내지 못한 일/ })).toBeDefined()
})

test('오류로 끝난 턴도 그때까지 고친 파일은 보인다 (R-5, R-8)', async ($, on) => {
  await world($, on)
  await turn($, '첫 요청', '첫 보고')
  const turnId = await ask($, '둘째 요청')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${CWD}/src/half.ts`, old_string: 'a', new_string: 'b' })
  const pane = await mountPane($)
  // 도는 중에도 보인다.
  expect((await pane.find({ key: 'file:0' }))?.text).toBe('src/half.ts')

  await $.turn.complete({ answer: '', durationMs: 3000, isAborted: false, turnId, reason: 'error' })
  expect(await pane.find({ type: 'Text', text: '■ 오류' })).toBeDefined()
  expect((await pane.find({ key: 'file:0' }))?.text).toBe('src/half.ts')
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('첫 보고')
})

test('파일 확인이 끝나지 않아도 턴은 제때 끝난 것으로 보인다 (R-23)', async ($, on) => {
  const seen = await world($, on)
  seen.isStatStuck = true
  await turn($, '요청', '결과는 /Volumes/NAS/share/report.pdf 에 있다. PR #7')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '✓ 완료' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /진행 중/ })).toBeUndefined()
  // 기다리다 그만두면 경로는 글자 그대로 두고, 저장소는 찾은 대로 건다.
  await seen.clock.advance(2500)
  const text = (await pane.find({ type: 'Markdown' }))?.props.text
  expect(text).toContain('/Volumes/NAS/share/report.pdf 에 있다')
  expect(text).toContain('[#7](https://github.com/acme/app/issues/7)')
})

test('뒤늦게 끝난 앞 턴이 지금 도는 턴의 기록을 지우지 않는다', async ($, on) => {
  await world($, on)
  const first = await ask($, '첫 요청')
  await ask($, '둘째 요청')
  await answer($, first, '첫 보고')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '둘째 요청' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /진행 중/ })).toBeDefined()
  expect((await pane.find({ type: 'Markdown' }))?.props.text).toBe('첫 보고')
})

test('막혀서 나가지 못한 제안은 고른 것으로 치지 않고 알린다 (R-11, R-23)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)
  seen.blocked.add('방금 고친 것을 커밋해줘')

  await pane.press({ key: 'next:1' })
  expect(seen.submitted).toEqual([])
  expect(seen.toasts.at(-1)).toContain('막혀 나가지 않았다')
  // 선택창이 그대로라 다른 제안을 고를 수 있다.
  expect(await pane.find({ key: 'next:0' })).toBeDefined()
  await pane.press({ key: 'next:0' })
  expect(seen.submitted).toEqual(['시뮬레이터에서 확인해줘'])
})

test('명령을 입력란에 채운 뒤에도 나머지 제안을 고를 수 있다 (R-11)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '고쳐줘', REPORT)
  const pane = await mountPane($)

  await pane.press({ key: 'next:2' })
  expect(seen.filled).toEqual(['/review 12'])
  // 채우기만 했으므로 선택창이 굳지 않는다.
  expect(await pane.find({ key: 'next:0' })).toBeDefined()
  await pane.press({ key: 'next:0' })
  expect(seen.submitted).toEqual(['시뮬레이터에서 확인해줘'])
})

test('막혀서 들어가지 못한 요청은 마지막 요청으로 남지 않는다 (R-1)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '첫 요청', '첫 보고')
  seen.blocked.add('막힐 요청')
  await $.prompt.submit({ text: '막힐 요청', origin: { kind: 'composer' }, wait: false })
  // 그 뒤 작업 알림으로 시작한 턴은 앞서 들어간 요청을 쓴다.
  await $.turn.start({ text: '', turnId: 'follow-up' })
  await answer($, 'follow-up', '이어서 한 보고')
  const pane = await mountPane($)

  expect(await pane.find({ type: 'Text', text: '첫 요청' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '막힐 요청' })).toBeUndefined()
})

test('제안이 바뀐 직후의 누름은 버리고 알린다', async ($, on) => {
  const seen = await world($, on)
  await turn($, '첫 요청', REPORT)
  const pane = await mountPane($)
  // 백그라운드 작업 알림으로 생긴 턴이 막 끝나 제안이 바뀌었다.
  await $.turn.start({ text: '', turnId: 'background' })
  await $.turn.complete({ answer: `알림 처리.\n\n\`\`\`next\n다른 일 | 근거 => 다른 일 해줘\n\`\`\``, durationMs: 10, isAborted: false, turnId: 'background', reason: 'answer' })
  await seen.clock.settle()

  await pane.press({ key: 'next:0' })
  expect(seen.submitted).toEqual([])
  expect(seen.toasts.at(-1)).toContain('제안이 방금 바뀌었다')

  await seen.clock.advance(2000)
  await pane.press({ key: 'next:0' })
  expect(seen.submitted).toEqual(['다른 일 해줘'])
})

test('원격 화면(데스크톱·모바일)에서는 링크를 보는 쪽이 열고, 세션 맥의 편집기는 열지 않는다 (R-28)', async ($, on) => {
  const seen = await world($, on)
  seen.files.add(`${CWD}/src/auth/authClient.ts`)
  const turnId = await ask($, '고쳐줘')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' })
  await answer($, turnId, REPORT)
  for (const surface of ['desktop', 'mobile'] as const) {
    const pane = await mountPane($, surface)

    // 본문 링크를 가로채지 않는다. cmux 안이어도 그 칸은 세션이 도는 맥에 뜨기 때문이다.
    const report = await pane.find({ type: 'Markdown' })
    expect(report?.props.onLinkPress).toBeUndefined()
    expect(report?.props.pressableLinks).toBeUndefined()
    // 링크 상자의 주소는 보는 쪽 화면이 여는 링크다.
    const links = await pane.findAll({ type: 'Link' })
    expect(links.map(link => link.props.href)).toEqual(['https://github.com/acme/app/issues/1234', 'https://example.com/docs'])
    // 파일은 누를 수 없는 글로만 보인다.
    expect(await pane.find({ key: 'link:0' })).toBeUndefined()
    expect(await pane.find({ key: 'file:0' })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /src\/auth\/authClient\.ts:42/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /src\/a\.ts/ })).toBeDefined()
    // 제안은 그대로 고를 수 있다.
    expect((await pane.find({ key: 'next:0' }))?.props.hotkey).toBe('1')
    await pane.unmount()
  }
  expect(seen.calls.some(call => call[0] === 'cmux' || call[0] === 'webstorm')).toBe(false)
})

test('보고의 표는 칸 상자로 그리고, 칸 안의 링크도 눌린다 (R-29)', async ($, on) => {
  const seen = await world($, on)
  await turn($, '조사해줘', '결과예요.\n\n| **항목** | 근거 |\n| --- | --- |\n| 원인 | https://example.com/a 참고 |\n\n끝.')
  const pane = await mountPane($)

  expect((await pane.find({ key: 'report' }))?.text).toContain('결과예요.')
  // 머리글은 마크다운 기호 없이 글로 그린다.
  expect(await pane.find({ type: 'Text', text: '항목' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '**항목**' })).toBeUndefined()
  expect((await pane.find({ key: 'report:1:0:1:text' }))?.text).toContain('example.com/a')
  expect((await pane.find({ key: 'report:2' }))?.text).toContain('끝.')

  await pane.press({ key: 'report:1:0:1:text', link: { href: 'https://example.com/a' } })
  expect(seen.calls.at(-1)).toEqual(['cmux', 'browser', 'open', 'https://example.com/a', '--focus', 'false'])
})

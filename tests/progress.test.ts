import { expect, test } from 'claude-code/testing'

import { activityOf, applyTaskTool, baseName, changedFile, clip, isAllDone, isTaskTool, shownPath } from '../hooks/progress'
import type { Step } from '../types'

test('도구 호출을 지금 하는 일 한 줄로 바꾼다 (R-6)', () => {
  expect(activityOf('Read', { file_path: '/work/app/src/auth/authClient.ts' })).toEqual({ label: '파일 읽는 중', target: 'authClient.ts' })
  expect(activityOf('Edit', { file_path: '/work/app/a.ts' })).toEqual({ label: '파일 고치는 중', target: 'a.ts' })
  expect(activityOf('Write', { file_path: '/work/app/b.ts' })).toEqual({ label: '파일 쓰는 중', target: 'b.ts' })
  expect(activityOf('Bash', { command: 'npm test -- --watch=false', description: '테스트 실행' })).toEqual({ label: '명령 실행 중', target: '테스트 실행' })
  expect(activityOf('Bash', { command: 'npm test\necho done' })).toEqual({ label: '명령 실행 중', target: 'npm test' })
  expect(activityOf('Grep', { pattern: 'refreshToken' })).toEqual({ label: '검색 중', target: 'refreshToken' })
  expect(activityOf('Agent', { description: '코드 리뷰' })).toEqual({ label: '하위 에이전트에 맡기는 중', target: '코드 리뷰' })
  expect(activityOf('WebFetch', { url: 'https://docs.example.com/a/b?c=1' })).toEqual({ label: '웹 페이지 읽는 중', target: 'docs.example.com' })
  expect(activityOf('TaskUpdate', { taskId: '1' })).toEqual({ label: '할 일 정리 중', target: '' })
  expect(activityOf('mcp__notion__search', {})).toEqual({ label: '도구 사용 중', target: 'notion · search' })
  expect(activityOf('SomethingNew', {})).toEqual({ label: '도구 사용 중', target: 'SomethingNew' })
})

test('인자가 없거나 모양이 달라도 터지지 않는다 (R-23)', () => {
  expect(activityOf('Read', {})).toEqual({ label: '파일 읽는 중', target: '' })
  expect(activityOf('Bash', { command: 42 })).toEqual({ label: '명령 실행 중', target: '' })
})

test('대상이 길면 끝을 자르고 한 줄로 만든다', () => {
  expect(clip('가'.repeat(60), 10)).toBe(`${'가'.repeat(9)}…`)
  expect(clip('\n\n  둘째 줄부터  \n셋째')).toBe('둘째 줄부터')
  expect(baseName('/a/b/c.ts')).toBe('c.ts')
  expect(baseName('/a/b/')).toBe('b')
  expect(baseName('c.ts')).toBe('c.ts')
})

test('TodoWrite는 목록 전체를 바꾼다 (R-6)', () => {
  const steps = applyTaskTool(
    [{ id: 'old', text: '옛 줄', state: 'todo' }],
    'TodoWrite',
    {
      todos: [
        { content: '원인 찾기', status: 'completed', activeForm: '원인 찾는 중' },
        { content: '고치기', status: 'in_progress', activeForm: '고치는 중' },
        { content: '테스트', status: 'pending', activeForm: '테스트하는 중' },
      ],
    },
    {},
  )

  expect(steps).toEqual([
    { id: 'todo:0', text: '원인 찾기', state: 'done' },
    { id: 'todo:1', text: '고치기', state: 'doing' },
    { id: 'todo:2', text: '테스트', state: 'todo' },
  ])
})

test('TaskCreate는 줄을 더하고 TaskUpdate는 상태를 바꾼다 (R-6)', () => {
  let steps: Step[] = []
  steps = applyTaskTool(steps, 'TaskCreate', { subject: '원인 찾기', description: '…' }, { task: { id: '1', subject: '원인 찾기' } })
  steps = applyTaskTool(steps, 'TaskCreate', { subject: '고치기', description: '…' }, { task: { id: '2', subject: '고치기' } })
  // 같은 id가 다시 와도 두 번 적지 않는다.
  steps = applyTaskTool(steps, 'TaskCreate', { subject: '고치기', description: '…' }, { task: { id: '2', subject: '고치기' } })
  steps = applyTaskTool(steps, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1', updatedFields: ['status'] })
  steps = applyTaskTool(steps, 'TaskUpdate', { taskId: '2', status: 'in_progress', subject: '토큰 대기열 고치기' }, { success: true })

  expect(steps).toEqual([
    { id: '1', text: '원인 찾기', state: 'done' },
    { id: '2', text: '토큰 대기열 고치기', state: 'doing' },
  ])

  expect(applyTaskTool(steps, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true })).toEqual([{ id: '1', text: '원인 찾기', state: 'done' }])
  // 실패한 갱신과 모르는 id는 건드리지 않는다.
  expect(applyTaskTool(steps, 'TaskUpdate', { taskId: '1', status: 'pending' }, { success: false })).toBe(steps)
  expect(applyTaskTool(steps, 'TaskUpdate', { taskId: '9', status: 'completed' }, { success: true })).toBe(steps)
})

test('TaskList는 목록 전체를 맞춘다: 앞선 턴에서 만든 할 일도 따라잡는다', () => {
  const steps = applyTaskTool([], 'TaskList', {}, {
    tasks: [
      { id: '1', subject: '원인 찾기', status: 'completed', blockedBy: [] },
      { id: '2', subject: '고치기', status: 'pending', blockedBy: [] },
    ],
  })

  expect(steps).toEqual([
    { id: '1', text: '원인 찾기', state: 'done' },
    { id: '2', text: '고치기', state: 'todo' },
  ])
})

test('할 일 도구가 아니면 체크리스트를 그대로 둔다', () => {
  const steps: Step[] = [{ id: '1', text: '줄', state: 'todo' }]

  expect(applyTaskTool(steps, 'Read', { file_path: '/a' }, {})).toBe(steps)
})

test('체크리스트를 다 끝냈는지 본다. 빈 목록은 끝낸 것이 아니다', () => {
  expect(isAllDone([])).toBe(false)
  expect(isAllDone([{ id: '1', text: '줄', state: 'done' }])).toBe(true)
  expect(isAllDone([{ id: '1', text: '줄', state: 'done' }, { id: '2', text: '줄', state: 'doing' }])).toBe(false)
})

test('파일을 고치거나 만든 호출에서 그 파일을 읽는다 (R-8)', () => {
  expect(changedFile('Edit', { file_path: '/work/app/a.ts' }, {})).toEqual({ path: '/work/app/a.ts', isNew: false })
  expect(changedFile('Write', { file_path: '/work/app/b.ts' }, { type: 'create' })).toEqual({ path: '/work/app/b.ts', isNew: true })
  expect(changedFile('Write', { file_path: '/work/app/b.ts' }, { type: 'update' })).toEqual({ path: '/work/app/b.ts', isNew: false })
  expect(changedFile('NotebookEdit', { notebook_path: '/work/app/n.ipynb' }, {})).toEqual({ path: '/work/app/n.ipynb', isNew: false })
  // 검토하도록 보류된 변경은 파일을 바꾸지 않았다. 오류를 적어 돌려준 호출도 그렇다.
  expect(changedFile('Write', { file_path: '/work/app/b.ts' }, { type: 'update', staged: true })).toBeNull()
  expect(changedFile('Edit', { file_path: '/work/app/a.ts' }, { staged: true })).toBeNull()
  expect(changedFile('NotebookEdit', { notebook_path: '/work/app/n.ipynb' }, { error: '셀이 없다' })).toBeNull()
  // 도구가 실제로 쓴 경로를 먼저 믿는다. 인자의 경로는 상대 경로일 수 있다.
  expect(changedFile('Edit', { file_path: 'src/a.ts' }, { filePath: '/work/app/src/a.ts' })).toEqual({ path: '/work/app/src/a.ts', isNew: false })
  expect(isTaskTool('TaskCreate')).toBe(true)
  expect(isTaskTool('Read')).toBe(false)
  expect(changedFile('Read', { file_path: '/work/app/a.ts' }, {})).toBeNull()
  expect(changedFile('Edit', {}, {})).toBeNull()
})

test('세션 폴더 안의 파일은 그 폴더 기준으로 보인다 (R-8)', () => {
  expect(shownPath('/work/app/src/a.ts', '/work/app')).toBe('src/a.ts')
  expect(shownPath('/work/app/src/a.ts', '/work/app/')).toBe('src/a.ts')
  expect(shownPath('/work/application/a.ts', '/work/app')).toBe('/work/application/a.ts')
  expect(shownPath('/etc/hosts', '/work/app')).toBe('/etc/hosts')
  expect(shownPath('/etc/hosts', '')).toBe('/etc/hosts')
})

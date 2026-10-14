import type { Activity, ChangedFile, Step, StepState } from '../types'

/** 한 줄의 말과 대상. 어느 호출의 것인지는 부르는 쪽이 붙인다. */
export type Doing = Omit<Activity, 'id'>

/** 도구 호출의 인자나 결과. 도구마다 모양이 달라 읽을 때마다 확인한다. */
export type Loose = Readonly<Record<string, unknown>>

const MAX_TARGET = 48

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 경로의 마지막 조각. */
export function baseName(path: string): string {
  const cut = path.replace(/[\\/]+$/, '')

  return cut.slice(Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\')) + 1)
}

function firstLine(value: string): string {
  return (
    value
      .split('\n')
      .map(line => line.trim())
      .find(line => line !== '') ?? ''
  )
}

/** 한 줄로 줄이고, 길면 끝을 자른다. */
export function clip(value: string, max: number = MAX_TARGET): string {
  const chars = Array.from(firstLine(value))

  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('')
}

function hostOf(url: string): string {
  return /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url
}

const TASK_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

/** 할 일 목록을 다루는 도구인가. */
export function isTaskTool(tool: string): boolean {
  return TASK_TOOLS.has(tool)
}

/** 도구 호출 하나를 "지금 하는 일" 한 줄로 바꾼다 (R-6). */
export function activityOf(tool: string, input: Loose): Doing {
  if (tool === 'Read') {
    return { label: '파일 읽는 중', target: baseName(text(input.file_path)) }
  }
  if (tool === 'Edit') {
    return { label: '파일 고치는 중', target: baseName(text(input.file_path)) }
  }
  if (tool === 'Write') {
    return { label: '파일 쓰는 중', target: baseName(text(input.file_path)) }
  }
  if (tool === 'NotebookEdit') {
    return { label: '노트북 고치는 중', target: baseName(text(input.notebook_path)) }
  }
  if (tool === 'Bash') {
    return { label: '명령 실행 중', target: clip(text(input.description) || text(input.command)) }
  }
  if (tool === 'Grep' || tool === 'Glob') {
    return { label: '검색 중', target: clip(text(input.pattern)) }
  }
  if (tool === 'Agent' || tool === 'Task') {
    return { label: '하위 에이전트에 맡기는 중', target: clip(text(input.description)) }
  }
  if (tool === 'WebFetch') {
    return { label: '웹 페이지 읽는 중', target: clip(hostOf(text(input.url))) }
  }
  if (tool === 'WebSearch') {
    return { label: '웹 검색 중', target: clip(text(input.query)) }
  }
  if (tool === 'Skill') {
    return { label: '스킬 실행 중', target: clip(text(input.skill)) }
  }
  if (tool === 'AskUserQuestion') {
    return { label: '사용자 답을 기다리는 중', target: '' }
  }
  if (TASK_TOOLS.has(tool)) {
    return { label: '할 일 정리 중', target: '' }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp !== null) {
    return { label: '도구 사용 중', target: clip(`${mcp[1]} · ${mcp[2]}`) }
  }

  return { label: '도구 사용 중', target: clip(tool) }
}

const STATES: Readonly<Record<string, StepState>> = { pending: 'todo', in_progress: 'doing', completed: 'done' }

function stateOf(status: unknown): StepState | null {
  return typeof status === 'string' ? (STATES[status] ?? null) : null
}

function list(value: unknown): Loose[] {
  return Array.isArray(value) ? value.filter((one): one is Loose => typeof one === 'object' && one !== null) : []
}

/**
 * 할 일 도구의 호출 하나를 체크리스트에 반영한다 (R-6).
 * `input`은 호출의 인자, `result`는 도구가 돌려준 값이다. 할 일 도구가 아니면 그대로 돌려준다.
 */
export function applyTaskTool(steps: Step[], tool: string, input: Loose, result: Loose): Step[] {
  if (tool === 'TodoWrite') {
    return list(input.todos).flatMap((todo, index) => {
      const state = stateOf(todo.status)
      const content = text(todo.content)

      return state === null || content === '' ? [] : [{ id: `todo:${index}`, text: content, state }]
    })
  }
  if (tool === 'TaskCreate') {
    const task = (result.task ?? {}) as Loose
    const id = text(task.id)
    const subject = text(task.subject) || text(input.subject)
    if (id === '' || subject === '' || steps.some(step => step.id === id)) {
      return steps
    }

    return [...steps, { id, text: subject, state: 'todo' }]
  }
  if (tool === 'TaskUpdate') {
    const id = text(input.taskId)
    if (result.success === false || !steps.some(step => step.id === id)) {
      return steps
    }
    if (input.status === 'deleted') {
      return steps.filter(step => step.id !== id)
    }
    const state = stateOf(input.status)
    const subject = text(input.subject)

    return steps.map(step => (step.id === id ? { ...step, text: subject || step.text, state: state ?? step.state } : step))
  }
  if (tool === 'TaskList') {
    // 목록 전체가 오므로 그대로 맞춘다. 앞선 턴에서 만든 할 일도 여기서 따라잡는다.
    return list(result.tasks).flatMap(task => {
      const state = stateOf(task.status)
      const id = text(task.id)
      const subject = text(task.subject)

      return state === null || id === '' || subject === '' ? [] : [{ id, text: subject, state }]
    })
  }

  return steps
}

/** 체크리스트를 다 끝냈는가. 빈 목록은 끝낸 것으로 치지 않는다. */
export function isAllDone(steps: Step[]): boolean {
  return steps.length > 0 && steps.every(step => step.state === 'done')
}

/** 파일을 고치거나 만든 호출이면 그 파일을 돌려준다 (R-8). 아니면 null. */
export function changedFile(tool: string, input: Loose, result: Loose): ChangedFile | null {
  // 사용자가 검토하도록 보류된 변경은 파일을 바꾸지 않았다. 오류를 적어 돌려준 호출도 그렇다.
  if (result.staged === true || text(result.error) !== '') {
    return null
  }
  // 도구가 실제로 쓴 경로를 먼저 믿는다. 인자의 경로는 상대 경로일 수 있다.
  if (tool === 'Edit' || tool === 'Write') {
    const path = text(result.filePath) || text(input.file_path)

    return path === '' ? null : { path, isNew: tool === 'Write' && result.type === 'create' }
  }
  if (tool === 'NotebookEdit') {
    const path = text(result.notebook_path) || text(input.notebook_path)

    return path === '' ? null : { path, isNew: false }
  }

  return null
}

/** 세션 폴더 안의 파일이면 그 폴더 기준으로, 밖이면 절대 경로 그대로 보인다. */
export function shownPath(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, '')

  return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

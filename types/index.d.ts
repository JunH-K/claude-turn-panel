/** 그 턴에서 고치거나 새로 만든 파일 (R-8) */
export type ChangedFile = {
  /** 절대 경로 */
  path: string
  isNew: boolean
}

/** 보고 본문에 나온 경로 가운데 실제로 있는 파일 (R-14). 적힌 글 → 절대 경로 */
export type FoundPaths = Record<string, string>

/** 정상 종료한 턴 하나: 요청과 최종 답변 원문 묶음 (R-2) */
export type Turn = {
  request: string
  answer: string
  /** 끝난 시각 (epoch ms) */
  endedAt: number
  durationMs: number
  files: ChangedFile[]
  paths: FoundPaths
  /** 세션 폴더의 GitHub 저장소 `owner/repo`. GitHub가 아니면 null (R-14) */
  repo: string | null
  /** 세션을 다시 열 때 저장된 대화에서 되살린 턴. 끝난 시각과 걸린 시간을 모른다 (R-32) */
  isRestored?: boolean
}

export type StepState = 'done' | 'doing' | 'todo'

/** 체크리스트 한 줄 (R-6) */
export type Step = {
  /** 할 일 도구가 준 id. TodoWrite 목록은 순번을 쓴다 */
  id: string
  text: string
  state: StepState
}

/** 도는 도구 호출 하나를 적은 줄 (R-6) */
export type Activity = {
  /** 이 줄을 만든 도구 호출의 id. 그 호출이 끝나면 줄을 지운다 */
  id: string
  /** "파일 읽는 중" 같은 말 */
  label: string
  /** 파일 이름이나 명령 앞부분. 없으면 빈 글 */
  target: string
}

export type RunStatus = 'running' | 'aborted' | 'error' | 'refusal'

/** 지금 도는 턴, 또는 정상 종료하지 못한 마지막 턴 */
export type Run = {
  /** 이 턴의 id. 뒤늦게 끝난 앞 턴이 이 턴의 기록을 지우지 않게 한다 */
  turnId: string
  request: string
  status: RunStatus
  /** 시작 시각 (epoch ms) */
  startedAt: number
  /** 끝난 턴이면 걸린 시간. 도는 중이면 null */
  durationMs: number | null
  /** 지금 도는 도구 호출들, 시작한 순서. 마지막 것을 "지금 하는 일"로 보인다 */
  activities: Activity[]
  files: ChangedFile[]
  /** 이 턴에서 할 일 도구를 썼는가. 쓴 턴에만 체크리스트를 보인다 */
  hasSteps: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'turn-panel': {
      /** 사람이 낸 마지막 요청 글 (R-1) */
      request: string
      run: Run | null
      /** 모델의 할 일 목록을 따라가는 체크리스트. 턴을 넘어 이어지고, 다 끝낸 채 턴이 끝나면 비운다 (R-6) */
      steps: Step[]
      /** 정상 종료한 턴들, 오래된 것부터. 최근 20개 (R-2) */
      history: Turn[]
      /** 넘겨 보는 자리. null이면 최신 (R-16) */
      view: number | null
      /** 방금 고른 제안의 문구. 다음 턴이 정상 종료할 때까지 선택창을 감춘다 (R-11) */
      picked: string | null
      /** 고쳐서 보내기 (R-12) */
      isEditing: boolean
      /** 사용자가 패널을 닫았다. 명령으로 다시 열 때까지 스스로 열지 않는다 (R-18) */
      isClosed: boolean
      /** 모드 기능을 껐다 (R-19) */
      isOff: boolean
      /** 패널이 화면에 놓여 있다. 놓여 있을 때만 대화 화면에서 제안 블록을 가린다 (R-10) */
      isPaneUp: boolean
      /** 화면이 읽는 지금 시각 (epoch ms). 시계가 갱신한다 (R-5) */
      now: number
      /** 세션 폴더. 바뀐 파일을 이 폴더 기준으로 보인다 (R-8) */
      cwd: string
      /** 이 세션이 링크를 연 cmux 브라우저 칸. 다음 링크는 이 칸의 주소만 바꾼다 (R-15) */
      browser: string | null
    }
  }
}

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { ChangedFile, Run, Step, Turn } from '../types'
import { linkify, parseFileHref, shortUrl } from './links'
import { columnPercents, splitTables } from './tables'
import type { Segment } from './tables'
import type { Linked } from './links'
import { asCommand, splitNext } from './nextBlock'
import type { Suggestion } from './nextBlock'
import { shownPath } from './progress'
import { agoText, failedText, requestLines, seatOf, tookText } from './record'
import type { Seat } from './record'

/** 터미널·데스크톱·VS Code·모바일에 모두 있는 요소만 쓴다. */
export type Ui = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Markdown' | 'Button' | 'Link'>

export type PanelModel = {
  history: Turn[]
  run: Run | null
  steps: Step[]
  /** 넘겨 보는 자리. null이면 최신 */
  view: number | null
  picked: string | null
  isEditing: boolean
  /** 지금 시각 (epoch ms) */
  now: number
  cwd: string
  /** 패널이 키보드를 쥐고 있는가. 단축키는 그때만 먹는다. */
  isFocused: boolean
  /** 터미널 화면에서 cmux 안인가. 아니면 주소 링크를 가로채지 않고 화면의 원래 동작에 맡긴다 (R-15). */
  canOpenWeb: boolean
  /**
   * 세션이 도는 맥의 터미널 화면에 그리는가 (R-28). 데스크톱 앱·웹·모바일로 원격에서 볼 때는 거짓이다.
   * 모드가 여는 브라우저 칸과 편집기는 세션이 도는 맥에 뜨므로, 원격 화면에서는 링크를 보는 쪽 화면이 열게 한다.
   */
  isTerminal: boolean
}

export type PanelHandlers = {
  onPick: (suggestion: Suggestion) => void
  onMove: (step: -1 | 1) => void
  onEdit: () => void
  onOpenWeb: (url: string) => void
  onOpenFile: (path: string, line: number | null) => void
}

const MAX_FILES = 8
const MAX_LINKS = 8

/** 구획 하나: 둥근 테두리 상자, 첫 줄이 제목 (R-3). */
function frame(ui: Ui, head: RenderElement, body: RenderElement): RenderElement {
  const { Box } = ui

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
      {head}
      {body}
    </Box>
  )
}

function title(ui: Ui, text: string, isMuted: boolean = false): RenderElement {
  const { Text } = ui

  return isMuted ? (
    <Text bold dimColor>
      {text}
    </Text>
  ) : (
    <Text bold color="claude">
      {text}
    </Text>
  )
}

/** 요청 상자: 제목 오른쪽에 상태와 시각, 아래에 줄바꿈을 살린 요청 글 (R-4, R-5). */
function request(ui: Ui, asked: string, status: RenderElement): RenderElement {
  const { Box, Text } = ui
  const clipped = requestLines(asked)

  return frame(
    ui,
    <Box flexDirection="row" justifyContent="space-between">
      {title(ui, '요청')}
      {status}
    </Box>,
    <Box flexDirection="column">
      {clipped.lines.length === 0 && <Text dimColor>(요청 글 없이 시작한 턴)</Text>}
      {clipped.lines.map(line => (
        <Text>{line === '' ? ' ' : line}</Text>
      ))}
      {clipped.hidden > 0 && <Text dimColor>{`… ${clipped.hidden}줄 더`}</Text>}
    </Box>,
  )
}

function doneStatus(ui: Ui, turn: Turn, now: number): RenderElement {
  const { Text } = ui

  return (
    <Text>
      <Text color="success">✓ 완료</Text>
      <Text dimColor>{turn.isRestored === true ? ' · 이전 실행' : ` · ${agoText(turn.endedAt, now)} · ${tookText(turn.durationMs)}`}</Text>
    </Text>
  )
}

function liveStatus(ui: Ui, run: Run, now: number): RenderElement {
  const { Text } = ui
  if (run.status === 'running') {
    return <Text color="claude">{`⏵ 진행 중 · ${tookText(now - run.startedAt)}`}</Text>
  }

  return (
    <Text>
      <Text color="warning">{`■ ${failedText(run.status)}`}</Text>
      {run.durationMs !== null && <Text dimColor>{` · ${tookText(run.durationMs)}`}</Text>}
    </Text>
  )
}

function step(ui: Ui, one: Step): RenderElement {
  const { Text } = ui
  if (one.state === 'done') {
    return (
      <Text dimColor>
        <Text color="success">✓</Text>
        {` ${one.text}`}
      </Text>
    )
  }
  if (one.state === 'doing') {
    return (
      <Text bold>
        <Text color="claude">⏵</Text>
        {` ${one.text}`}
      </Text>
    )
  }

  return <Text dimColor>{`○ ${one.text}`}</Text>
}

/** 진행 상자: 지금 하는 일 한 줄, 그 아래 체크리스트 (R-6). */
function progress(ui: Ui, run: Run, steps: Step[]): RenderElement {
  const { Box, Text } = ui
  // 함께 도는 호출이 여럿이면 가장 늦게 시작한 것을 보인다.
  const activity = run.activities.at(-1)

  return frame(
    ui,
    title(ui, '진행'),
    <Box flexDirection="column">
      {activity === undefined ? (
        <Text dimColor>생각하는 중</Text>
      ) : (
        <Text>
          <Text color="claude">⏵ </Text>
          {activity.label}
          {activity.target !== '' && <Text dimColor>{`  ${activity.target}`}</Text>}
        </Text>
      )}
      {/* 이 턴에서 할 일 도구를 쓰지 않았으면 앞선 턴의 목록을 끌고 오지 않는다. */}
      {run.hasSteps && steps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {steps.map(one => step(ui, one))}
        </Box>
      )}
    </Box>,
  )
}

// 링크로 바꾼 결과를 기억해 둔다. 도는 턴 동안 패널이 초마다 다시 그려지는데, 보고는 그대로다.
const linkedCache = new Map<string, Linked>()
const MAX_CACHED = 8

/** 보고 본문의 주소·번호·경로를 링크로 바꾼 글 (R-13). */
function linkedReport(turn: Turn): Linked {
  const key = JSON.stringify([turn.answer, turn.repo, turn.paths])
  const known = linkedCache.get(key)
  if (known !== undefined) {
    return known
  }
  const linked = linkify(splitNext(turn.answer).body, { repo: turn.repo, paths: turn.paths })
  if (linkedCache.size >= MAX_CACHED) {
    linkedCache.clear()
  }
  linkedCache.set(key, linked)

  return linked
}

// 링크의 주소를 보고 브라우저 칸으로 보낼지 편집기로 보낼지 가른다.
function press(href: string, handlers: PanelHandlers): void {
  const file = parseFileHref(href)
  if (file === null) {
    handlers.onOpenWeb(href)
  } else {
    handlers.onOpenFile(file.path, file.line)
  }
}

/** 보고 상자. 본문의 주소 링크는 누르면(클릭) 연다. 파일은 본문에서 링크로 걸지 않는다 (R-13, R-15, R-25). */
function report(ui: Ui, linked: Linked, isPrevious: boolean, model: PanelModel, handlers: PanelHandlers): RenderElement {
  const { Box, Text } = ui

  return frame(
    ui,
    title(ui, isPrevious ? '직전 보고' : '보고', isPrevious),
    linked.markdown.trim() === '' ? (
      <Text dimColor>이 턴은 최종 답변 글 없이 끝났다.</Text>
    ) : (
      <Box flexDirection="column" rowGap={1}>
        {splitTables(linked.markdown).map((segment, index) => reportPart(ui, segment, index, linked, isPrevious, model, handlers))}
      </Box>
    ),
  )
}

// 마크다운 한 덩이. 첫 덩이의 열쇠는 `report`다.
function markdownPart(ui: Ui, key: string, text: string, linked: Linked, isPrevious: boolean, model: PanelModel, handlers: PanelHandlers): RenderElement {
  const { Markdown } = ui
  // cmux 밖에서는 본문의 주소 링크를 가로채지 않고 화면의 원래 동작에 맡긴다.
  const pressable = model.canOpenWeb ? linked.web : []

  return pressable.length === 0 ? (
    <Markdown key={key} text={text} dimColor={isPrevious} />
  ) : (
    <Markdown key={key} text={text} dimColor={isPrevious} onLinkPress={link => press(link.href, handlers)} pressableLinks={pressable} />
  )
}

// 머리글 칸의 마크다운을 글로 편다: 링크는 글자만, 강조·코드 기호와 이스케이프는 뗀다.
function plainText(cell: string): string {
  return cell
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>&])/g, '$1')
}

// 패널 폭을 넘지 않는 가로줄. 한 줄 높이로 자른다.
function rule(ui: Ui, key: string): RenderElement {
  const { Box, Text } = ui

  return (
    <Box key={key} height={1} overflow="hidden">
      <Text dimColor>{'─'.repeat(400)}</Text>
    </Box>
  )
}

/**
 * 보고의 한 조각. 표는 칸 상자로 그려 패널 폭에 맞춘다. 칸에 다 안 들어가는 글은 그 칸 안에서 줄을 바꾼다 (R-29).
 * 엔진의 Markdown은 패널 안의 표를 터미널 폭으로 그려 꺾이게 한다.
 */
function reportPart(
  ui: Ui,
  segment: Segment,
  index: number,
  linked: Linked,
  isPrevious: boolean,
  model: PanelModel,
  handlers: PanelHandlers,
): RenderElement {
  const { Box, Text } = ui
  const key = index === 0 ? 'report' : `report:${index}`
  if (segment.kind === 'markdown') {
    return markdownPart(ui, key, segment.text, linked, isPrevious, model, handlers)
  }
  const percents = columnPercents(segment.header, segment.rows)
  const row = (cells: string[], at: string, isHeader: boolean): RenderElement => (
    <Box key={`${key}:${at}`} flexDirection="row" columnGap={2}>
      {cells.map((cell, column) => (
        <Box key={`${key}:${at}:${column}`} width={`${percents[column] ?? 0}%`} flexShrink={1}>
          {cell === '' ? (
            <Text> </Text>
          ) : isHeader ? (
            <Text bold color={isPrevious ? undefined : 'claude'} dimColor={isPrevious}>
              {plainText(cell)}
            </Text>
          ) : (
            markdownPart(ui, `${key}:${at}:${column}:text`, cell, linked, isPrevious, model, handlers)
          )}
        </Box>
      ))}
    </Box>
  )

  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {row(segment.header, 'head', true)}
      {segment.rows.flatMap((cells, at) => [rule(ui, `${key}:rule:${at}`), row(cells, String(at), false)])}
    </Box>
  )
}

type LinkRow = { href: string; label: string; isFile: boolean }

// 링크 상자에 보일 줄들. 바뀐 파일 상자에 이미 있는 파일은 다시 적지 않는다.
function linkRows(linked: Linked, turn: Turn, cwd: string): LinkRow[] {
  const rows: LinkRow[] = linked.web.map(href => ({ href, label: shortUrl(href), isFile: false }))
  for (const href of linked.files) {
    const file = parseFileHref(href)
    if (file === null || (file.line === null && turn.files.some(changed => changed.path === file.path))) {
      continue
    }
    rows.push({ href, label: `${shownPath(file.path, cwd)}${file.line === null ? '' : `:${file.line}`}`, isFile: true })
  }

  return rows
}

/**
 * 링크 상자: 보고 본문의 링크를 단추로 다시 늘어놓는다 (R-13).
 * 본문 안의 링크는 클릭으로만 눌리고 Tab이 닿지 않는다. 키보드로 여는 길은 이 상자다.
 */
function links(ui: Ui, rows: LinkRow[], isTerminal: boolean, handlers: PanelHandlers): RenderElement {
  const { Box, Text, Button, Link } = ui
  const shown = rows.slice(0, MAX_LINKS)

  return frame(
    ui,
    title(ui, `링크 (${rows.length})`),
    <Box flexDirection="column">
      {shown.map((row, index) =>
        isTerminal ? (
          <Button key={`link:${index}`} plain onPress={() => press(row.href, handlers)}>
            {row.label}
          </Button>
        ) : row.isFile ? (
          // 원격 화면에서 파일을 열면 세션이 도는 맥의 편집기에 뜬다. 보는 쪽에서는 열 수 없으니 이름만 보인다.
          <Text dimColor>{row.label}</Text>
        ) : (
          // 원격 화면에서는 보는 쪽 화면이 주소를 연다.
          <Text>
            <Link href={row.href}>{row.label}</Link>
          </Text>
        ),
      )}
      {rows.length > shown.length && <Text dimColor>{`… ${rows.length - shown.length}개 더. 보고 본문에서 누른다.`}</Text>}
    </Box>,
  )
}

/** 바뀐 파일 상자. 누르면 편집기로 연다 (R-8). */
function files(ui: Ui, changed: ChangedFile[], cwd: string, isTerminal: boolean, handlers: PanelHandlers): RenderElement {
  const { Box, Text, Button } = ui
  const shown = changed.slice(0, MAX_FILES)

  return frame(
    ui,
    title(ui, `바뀐 파일 (${changed.length})`),
    <Box flexDirection="column">
      {shown.map((file, index) =>
        isTerminal ? (
          <Button key={`file:${index}`} plain onPress={() => handlers.onOpenFile(file.path, null)}>
            {shownPath(file.path, cwd)}
            <Text dimColor>{file.isNew ? '  새 파일' : ''}</Text>
          </Button>
        ) : (
          // 원격 화면에서는 세션이 도는 맥의 편집기를 열지 않는다 (R-28).
          <Text>
            {shownPath(file.path, cwd)}
            <Text dimColor>{file.isNew ? '  새 파일' : ''}</Text>
          </Text>
        ),
      )}
      {changed.length > shown.length && <Text dimColor>{`… ${changed.length - shown.length}개 더`}</Text>}
    </Box>,
  )
}

// 지난 턴의 제안: 고를 수는 없고 읽기만 한다. 대화 화면에서 가린 블록이 여기 보인다 (R-10, R-16).
function pastSuggestions(ui: Ui, turn: Turn): RenderElement {
  const { Box, Text } = ui
  const { suggestions: offered } = splitNext(turn.answer)

  return frame(
    ui,
    title(ui, '다음 작업 (지난 턴이라 고르지 않는다)', true),
    offered.length === 0 ? (
      <Text dimColor>제안 없음</Text>
    ) : (
      <Box flexDirection="column">
        {offered.map(suggestion => (
          <Text dimColor>{`· ${suggestion.label} — ${suggestion.text}`}</Text>
        ))}
      </Box>
    ),
  )
}

/**
 * 다음 작업 상자: 문구는 굵게, 근거와 보낼 글은 그 아래 흐리게 (R-9, R-11, R-12).
 * 보낼 글은 줄이지 않고 그대로 보인다. 문구만 보고 고르면 문구와 다른 글이 나갈 수 있다.
 */
function suggestions(ui: Ui, turn: Turn, model: PanelModel, handlers: PanelHandlers): RenderElement {
  const { Box, Text, Button } = ui
  const { suggestions: offered, extra } = splitNext(turn.answer)

  return frame(
    ui,
    title(ui, '다음 작업'),
    model.picked !== null ? (
      <Text dimColor>{`고른 제안: ${model.picked}`}</Text>
    ) : offered.length === 0 ? (
      <Text dimColor>제안 없음</Text>
    ) : (
      <Box flexDirection="column">
        {offered.map((suggestion, index) => (
          <Box flexDirection="column" marginTop={index === 0 ? 0 : 1}>
            <Button key={`next:${index}`} plain hotkey={String(index + 1)} onPress={() => handlers.onPick(suggestion)}>
              <Text bold>{suggestion.label}</Text>
            </Button>
            {suggestion.reason !== '' && (
              <Box paddingLeft={3}>
                <Text dimColor>{`근거 · ${suggestion.reason}`}</Text>
              </Box>
            )}
            <Box paddingLeft={3}>
              {asCommand(suggestion.text) === null ? (
                <Text dimColor>{`보냄 · ${suggestion.text}`}</Text>
              ) : (
                <Text color="warning">{`명령 · ${suggestion.text}  (누르면 입력란에 채운다)`}</Text>
              )}
            </Box>
          </Box>
        ))}
        {extra > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{`제안 ${extra}개가 더 적혀 있다. ctrl+o로 답변 원문을 펼치면 보인다.`}</Text>
          </Box>
        )}
        {model.isEditing && (
          <Box marginTop={1}>
            <Text color="warning">고쳐서 보내기: 숫자를 누르면 입력란에 채운다</Text>
          </Box>
        )}
      </Box>
    ),
  )
}

/** 맨 아래 단축키 줄. 단추라야 키가 먹으므로 흐린 단추로 작게 그린다 (R-17). */
function footer(ui: Ui, seat: Seat, model: PanelModel, handlers: PanelHandlers): RenderElement {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>{`턴 ${seat.at + 1}/${seat.total}`}</Text>
        <Button key="turn:prev" plain dimColor hotkey="p" onPress={() => handlers.onMove(-1)}>
          이전
        </Button>
        <Button key="turn:next" plain dimColor hotkey="n" onPress={() => handlers.onMove(1)}>
          다음
        </Button>
        <Button key="edit" plain dimColor={!model.isEditing} hotkey="e" onPress={() => handlers.onEdit()}>
          고쳐서 보내기
        </Button>
      </Box>
      <Text dimColor>
        {model.isFocused ? '1~3 제안 보내기 · Tab 링크·파일 · Esc 입력란' : 'ctrl+x tab으로 패널에 초점을 준 뒤 키를 쓴다'}
      </Text>
    </Box>
  )
}

/** 패널 한 장: 요청 → (진행) 또는 다음 작업 → 보고 → 링크 → 바뀐 파일 → 단축키 (R-3). */
export function Panel(ui: Ui, model: PanelModel, handlers: PanelHandlers): RenderElement {
  const { Box, Text } = ui
  const { history, run } = model
  const seat = seatOf(model.view, history.length, run !== null)

  if (seat.total === 0) {
    return <Text dimColor>아직 끝난 턴이 없다. 요청을 보내면 여기에 요청과 보고가 묶여 보인다.</Text>
  }

  if (seat.isLive && run !== null) {
    // 도는 턴(또는 정상 종료하지 못한 턴)의 요청과 진행을 위에, 그 앞 턴의 보고를 흐리게 아래에 둔다 (R-7).
    const before = history.at(-1)

    return (
      <Box flexDirection="column">
        {request(ui, run.request, liveStatus(ui, run, model.now))}
        {run.status === 'running' && progress(ui, run, model.steps)}
        {/* 도는 중에도, 중단·오류로 끝난 뒤에도 이 턴이 이미 고친 파일은 보인다 (R-8). */}
        {run.files.length > 0 && files(ui, run.files, model.cwd, model.isTerminal, handlers)}
        {before !== undefined && report(ui, linkedReport(before), true, model, handlers)}
        {footer(ui, seat, model, handlers)}
      </Box>
    )
  }

  const turn = history[seat.at]
  if (turn === undefined) {
    return <Text dimColor>이 자리에 턴이 없다.</Text>
  }
  // 지난 턴의 제안은 이미 지나간 일이라 고르지 못하게 숨긴다 (R-16).
  const isLatest = run === null && seat.at === history.length - 1
  const linked = linkedReport(turn)
  const rows = linkRows(linked, turn, model.cwd)

  return (
    <Box flexDirection="column">
      {/* 다음 작업 상자는 요청 바로 아래에 둔다. 보고가 길어도 고를 글이 화면 밖으로 밀려나지 않고,
          보고 본문에 상자를 흉내 낸 글이 있어도 진짜 상자가 먼저 보인다. */}
      {request(ui, turn.request, doneStatus(ui, turn, model.now))}
      {isLatest ? suggestions(ui, turn, model, handlers) : pastSuggestions(ui, turn)}
      {report(ui, linked, false, model, handlers)}
      {rows.length > 0 && links(ui, rows, model.isTerminal, handlers)}
      {turn.files.length > 0 && files(ui, turn.files, model.cwd, model.isTerminal, handlers)}
      {footer(ui, seat, model, handlers)}
    </Box>
  )
}

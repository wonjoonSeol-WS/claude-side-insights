import { Kind, RecordStatus, Source, Status, isAbsolutePath, turnRow, type FileChange, type FlowRecord, type FlowRef, type FlowStep, type QaItem, type QaTurn } from './data'
import type { View } from './views'

export const MAX_FILES = 30
const MAX_TURNS = 20
const OPEN_STATUSES = new Set<string>([Status.PARTIAL, Status.UNANSWERED])
const KNOWN_KINDS = new Set<string>(Object.values(Kind))

export type Change = NonNullable<NonNullable<FlowRecord['flow']>['changes']>[number]

export const clampIndex = (index: number, length: number) => Math.max(0, Math.min(length - 1, index))

export const isOpen = (item: QaItem) => OPEN_STATUSES.has(item.status ?? '')
export const canCopy = (item: QaItem | undefined) => !!item && isOpen(item) && !item.archived && !item.manual

export const findItem = (turns: QaTurn[], id: string | undefined) => (id ? turns.flatMap(x => x.items ?? []).find(i => i.id === id) : undefined)

export const sortedFiles = (files: FileChange[] | undefined) => [...(files ?? [])].sort((a, b) => b.last - a.last)

export const kindOf = (step: FlowStep) => (step.kind && KNOWN_KINDS.has(step.kind) ? step.kind : Kind.LOGIC)

export const currentFlow = (flows: FlowRef[], flowId: string | undefined) => {
  const found = flows.findIndex(f => f.id === flowId)
  const index = found < 0 ? 0 : found
  return { index, ref: flows[index] }
}

export const visibleTurns = (view: View, turns: QaTurn[]) =>
  turns
    .map(turn => {
      const failed = turn.status !== undefined && turn.status !== RecordStatus.OK
      const shown = (turn.items ?? []).filter(
        i => (view.showArchived || !i.archived) && !(view.openOnly && i.status === Status.ANSWERED) && (!view.statusFilter || i.status === view.statusFilter),
      )
      return { turn, failed, shown }
    })
    .filter(({ failed, shown }) => failed || shown.length || !(view.openOnly || view.showArchived || view.statusFilter))

export type TurnEntry = ReturnType<typeof visibleTurns>[number]

export const qaPage = (view: View, turns: QaTurn[]) => {
  const all = visibleTurns(view, turns)
  const shown = all.slice(0, MAX_TURNS)
  return { shown, more: all.length - shown.length }
}

const rowIds = (shown: TurnEntry[]) => shown.flatMap(({ turn, failed, shown: items }) => [...(failed ? [turnRow(turn.turn_id)] : []), ...items.map(i => i.id)])

export const isShown = (view: View, turns: QaTurn[], id: string) => rowIds(qaPage(view, turns).shown).includes(id)

export const selection = (view: View, turns: QaTurn[]): string | undefined => {
  const { shown } = qaPage(view, turns)
  if (view.selected && rowIds(shown).includes(view.selected)) {
    return view.selected
  }
  return shown.flatMap(x => x.shown).find(isOpen)?.id
}

export const changeFiles = (file: string | undefined): string[] => {
  const parts = (file ?? '').split(/\s*,\s*/).map(x => x.trim()).filter(Boolean)
  const first = parts[0] ?? ''
  const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/') + 1) : ''
  return parts.map((x, i) => (i === 0 || x.includes('/') ? x : `${dir}${x}`))
}

const slashes = (path: string) => path.replace(/\\/g, '/')

const sameFile = (a: string, b: string) => {
  const x = slashes(a).replace(/^~\//, '')
  const y = slashes(b).replace(/^~\//, '')
  return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`))
}

const MATCH_MIN = 8
const MESSAGE_PREFIX = 300
const MAX_MESSAGES = 300

const squashSpaces = (text: string) => text.slice(0, MESSAGE_PREFIX * 2).replace(/\s+/g, ' ').trim().slice(0, MESSAGE_PREFIX)

export const rememberMessage = (shown: Map<string, string>, requestId: string, text: string) => {
  if (shown.has(requestId)) {
    return
  }
  shown.set(requestId, squashSpaces(text))
  if (shown.size > MAX_MESSAGES) {
    shown.delete(shown.keys().next().value as string)
  }
}

const newest = (shown: Map<string, string>, test: (message: string) => boolean) => {
  let found: string | undefined
  for (const [id, message] of shown) {
    if (test(message)) {
      found = id
    }
  }
  return found
}

const promptMessage = (shown: Map<string, string>, prompt: string | undefined) => {
  const want = squashSpaces(prompt ?? '')
  if (!want) {
    return undefined
  }
  const long = (message: string) => Math.min(message.length, want.length) >= MATCH_MIN
  return newest(shown, m => m === want) ?? newest(shown, m => long(m) && (m.startsWith(want) || want.startsWith(m)))
}

const messageContaining = (shown: Map<string, string>, question: string | undefined) => {
  const want = squashSpaces(question ?? '')
  return want.length >= MATCH_MIN ? newest(shown, m => m.includes(want)) : undefined
}

export const jumpTargets = (turn: QaTurn, item: QaItem, shown: Map<string, string>) => {
  const own = item.from === Source.MID_TURN ? [messageContaining(shown, item.question)] : []
  return [...new Set([...own, turn.turn_id, promptMessage(shown, turn.prompt)].filter((x): x is string => !!x))]
}

const underDir = (path: string, dir: string | undefined) => !!dir && slashes(path).startsWith(`${slashes(dir).replace(/\/$/, '')}/`)

export const resolveChange = (file: string, known: readonly string[], cwd?: string) => {
  const matches = known.filter(k => sameFile(k, file))
  const found = matches.find(k => underDir(k, cwd)) ?? matches[0]
  if (found) {
    return found
  }
  return isAbsolutePath(file) || file.startsWith('~/') || !cwd ? file : `${cwd.replace(/[\\/]$/, '')}/${file}`
}

export const stepChanges = (s: FlowStep, changes: Change[]) => {
  const file = (s.location ?? '').split(' ')[0] ?? ''
  return file ? changes.filter(ch => changeFiles(ch.file).some(f => sameFile(f, file))) : []
}

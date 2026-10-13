import { Kind, RecordStatus, Status, turnRow, type FileChange, type FlowRecord, type FlowRef, type FlowStep, type QaItem, type QaTurn } from './data'
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

const sameFile = (a: string, b: string) => {
  const x = a.replace(/^~\//, '')
  const y = b.replace(/^~\//, '')
  return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`))
}

export const stepChanges = (s: FlowStep, changes: Change[]) => {
  const file = (s.location ?? '').split(' ')[0] ?? ''
  return file ? changes.filter(ch => changeFiles(ch.file).some(f => sameFile(f, file))) : []
}

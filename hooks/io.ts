import type { FsEntry, Timer } from 'claude-code'

import type { ApiSection, Draft, ListSort, Notice, PromptModeState, PromptVariant, Tab, Target } from '../types'

/**
 * What the modules other than register.tsx may do outside themselves. Only register.tsx spells `$` (the engine checks that a
 * module calls `$` where it can read the call), and it hands everything else these closures over one hook's `$`.
 */
export type Io = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  home: () => Promise<string>
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, text: string) => Promise<void>
  listDir: (path: string) => Promise<FsEntry[]>
  exists: (path: string) => Promise<boolean>
  /** The file's modification time, or undefined when it does not exist. */
  mtime: (path: string) => Promise<number | undefined>
  /** Has Claude Code ask for the session's tools again at the next turn, so a removed or restored tool takes effect. */
  invalidateTools: () => void
  /** Runs a command by its argument vector, no shell, and resolves once it exits, whatever its exit code. */
  run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** The folder the mod is installed in. */
  pluginRoot: () => string
  set: StateSetters
  /** Reads the unsaved editor content as it stands now, for a handler that acts on it. */
  getDraft: () => Promise<Draft | null>
}

/** Writes of the panel's $.state values; each redraws what reads it. */
export type StateSetters = {
  tab: (value: Tab) => Promise<void>
  selected: (value: Target | null) => Promise<void>
  draft: (value: Draft | null) => Promise<void>
  /** Changes the draft from its current value, so two edits made before a redraw both land. */
  updateDraft: (change: (current: Draft | null) => Draft | null) => Promise<void>
  notice: (value: Notice | null) => Promise<void>
  promptMode: (value: PromptModeState) => Promise<void>
  promptView: (value: PromptVariant | null) => Promise<void>
  toolSearch: (value: string) => Promise<void>
  historySession: (value: string | null) => Promise<void>
  historyItem: (value: number | null) => Promise<void>
  historySearch: (value: string) => Promise<void>
  /** Also keeps the choice in the mod's store, so later sessions open with it. */
  listSort: (value: ListSort) => Promise<void>
  apiItem: (value: number | null) => Promise<void>
  apiExpanded: (value: ApiSection[]) => Promise<void>
  updateApiExpanded: (change: (current: ApiSection[]) => ApiSection[]) => Promise<void>
  /** Redraws the panel after a change it cannot see in $.state: rules, catalog or history read from disk. */
  redraw: () => Promise<void>
}

/** The panel's $.state values, read once per drawing. */
export type PaneState = {
  tab: Tab
  selected: Target | null
  draft: Draft | null
  notice: Notice | null
  promptMode: PromptModeState
  promptView: PromptVariant | null
  toolSearch: string
  historySession: string | null
  historyItem: number | null
  historySearch: string
  listSort: ListSort
  apiItem: number | null
  apiExpanded: ApiSection[]
}

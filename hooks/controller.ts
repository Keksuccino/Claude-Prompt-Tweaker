import type { ApiSection, Draft, EditMode, Kind, ListSort, Notice, Patch, PromptMode, PromptVariant, Seen, SessionHistory, Tab, Target } from '../types'
import type { DesktopAppend } from './desktop'
import { readDesktopAppend } from './desktop'
import type { Io } from './io'
import { changingTexts, textKey } from './history'
import { ApiTraffic } from './recordings'
import { ADDED_PREFIX, fillOriginal, inheritedRule, nextAddedId, ruleMap, withRule } from './rules'
import { promptModeOf, readSettings, SETTINGS_UNREADABLE, withPromptMode, writeSettings } from './settings'
import type { TweakerStore } from './store'

/** A session's history file as the History tab lists it. */
export type HistorySummary = { sessionId: string; cwd: string; startedAt: number; lastAt: number; itemCount: number }

/** The History tab, and the check for texts that change between sessions, read this many of the newest session files. */
const MAX_LISTED_HISTORIES = 80

const EMPTY_PATCH: Patch = { find: '', replace: '' }

/** When a change reaches the model, by kind: said after every save so nobody waits for an edit that only applies later. */
const APPLIES: Record<Kind | 'added', string> = {
  section: 'It applies to new conversations; this one keeps the prompt it was sent.',
  added: 'It applies to new conversations; this one keeps the prompt it was sent.',
  context: 'It applies to new conversations and after a compaction.',
  attachment: 'It applies from the next message of this type.',
  tool: 'It applies to new conversations; this one keeps the tool list it was sent.',
}

/** What the panel's buttons and fields do, and the data it shows that is read from disk on demand. */
export class TweakerController {

  desktop: DesktopAppend | null = null
  isDesktopLoaded = false
  histories: HistorySummary[] | null = null
  openedHistory: SessionHistory | null = null
  /** History texts read so far, by hash: a text never changes, so it is read once. */
  readonly texts = new Map<string, string | null>()
  /** The items whose text was not always the same (see `textKey`), across the recent sessions and this one. */
  changing = new Set<string>()
  /** The API Traffic tab's data. */
  readonly api = new ApiTraffic()
  /** The recent sessions' histories, read when the panel opens; this session's own is read live. */
  private pastHistories: SessionHistory[] = []

  constructor(readonly store: TweakerStore) {}

  async selectTab(io: Io, next: Tab): Promise<void> {
    await this.store.refreshRules(io)
    await io.set.tab(next)
    await io.set.selected(null)
    await io.set.draft(null)
    await io.set.notice(null)
    this.refreshChanging()
    if (next === 'desktop') {
      await this.loadDesktop(io)
    } else if (next === 'history') {
      await io.set.historySession(null)
      await io.set.historyItem(null)
      await this.loadHistories(io)
    } else if (next === 'prompt') {
      await this.refreshPromptMode(io)
    } else if (next === 'api') {
      await this.api.open(io, null)
      await this.api.load(io)
    }
  }

  async open(io: Io, target: Target): Promise<void> {
    await io.set.selected(target)
    await io.set.draft(null)
    await io.set.notice(null)
  }

  async back(io: Io): Promise<void> {
    await io.set.selected(null)
    await io.set.draft(null)
  }

  async discardDraft(io: Io): Promise<void> {
    await io.set.draft(null)
  }

  /** The editor content of a target as saved: its rule, else the engine's text in full replacement mode. */
  savedEditor(target: Target): Draft {
    const key = draftKey(target)
    if (target.kind === 'added') {
      return { key, mode: 'full', text: this.store.rules.added.find(one => one.id === target.name)?.text ?? '', patches: [EMPTY_PATCH] }
    }
    const rule = ruleMap(this.store.rules, target.kind)[target.name]
    const original = this.original(target.kind, target.name, target.variant) ?? ''
    if (rule?.mode === 'patch') {
      return { key, mode: 'patch', text: original, patches: rule.patches }
    }

    return { key, mode: 'full', text: rule?.mode === 'replace' ? rule.text : original, patches: [EMPTY_PATCH] }
  }

  /** The editor content of a target: the unsaved draft when it is this target's, else what is saved. */
  editorFor(target: Target, draft: Draft | null): Draft {
    return draft !== null && draft.key === draftKey(target) ? draft : this.savedEditor(target)
  }

  /** Whether the editor holds content that saving would change, in the mode it shows. */
  isUnsaved(target: Target, draft: Draft | null): boolean {
    if (draft === null || draft.key !== draftKey(target)) {
      return false
    }
    const saved = this.savedEditor(target)
    if (draft.mode !== saved.mode) {
      return true
    }

    return draft.mode === 'full' ? draft.text !== saved.text : JSON.stringify(usedPatches(draft.patches)) !== JSON.stringify(usedPatches(saved.patches))
  }

  async setEditMode(io: Io, target: Target, mode: EditMode): Promise<void> {
    await this.editDraft(io, target, current => ({ ...current, mode }))
  }

  async setDraftText(io: Io, target: Target, text: string): Promise<void> {
    await this.editDraft(io, target, current => ({ ...current, text }))
  }

  async setPatch(io: Io, target: Target, index: number, field: keyof Patch, value: string): Promise<void> {
    await this.editDraft(io, target, current => ({ ...current, patches: current.patches.map((patch, at) => (at === index ? { ...patch, [field]: value } : patch)) }))
  }

  async addPatch(io: Io, target: Target): Promise<void> {
    await this.editDraft(io, target, current => ({ ...current, patches: [...current.patches, EMPTY_PATCH] }))
  }

  /** Removes a pair; the last one is emptied instead, so the editor always has a pair to type into. */
  async removePatch(io: Io, target: Target, index: number): Promise<void> {
    await this.editDraft(io, target, current => {
      const patches = current.patches.filter((_, at) => at !== index)

      return { ...current, patches: patches.length === 0 ? [EMPTY_PATCH] : patches }
    })
  }

  /**
   * Saves the editor as it stands now, in the mode it shows. A full replacement that sends the engine's text unchanged,
   * or find-and-replace without a pair to find, removes the rule instead.
   */
  async save(io: Io, target: Target): Promise<void> {
    const editor = this.editorFor(target, await io.getDraft())
    const rules = this.store.rules
    if (target.kind === 'added') {
      await this.store.saveRules(io, { ...rules, added: rules.added.map(one => (one.id === target.name ? { ...one, text: editor.text } : one)) })
      await this.tell(io, { text: `Saved your section. ${APPLIES.added}`, isError: false })
      await io.set.draft(null)

      return
    }
    const original = this.original(target.kind, target.name, target.variant)
    const patches = usedPatches(editor.patches)
    const isUnchanged = editor.mode === 'full' ? original !== undefined && fillOriginal(editor.text, original) === original : patches.length === 0
    const rule = isUnchanged ? undefined : editor.mode === 'full' ? { mode: 'replace' as const, text: editor.text } : { mode: 'patch' as const, patches }
    await this.store.saveRules(io, withRule(rules, target.kind, target.name, rule))
    const followed = inheritedRule(this.store.rules, target.kind, target.name)?.parent
    const unchanged = followed === undefined ? 'it is sent as Claude Code makes it' : `it follows your edit of ${followed}`
    await this.tell(io, { text: rule === undefined ? `Nothing to change, so ${unchanged}. ${APPLIES[target.kind]}` : `Saved. ${APPLIES[target.kind]}`, isError: false })
    await io.set.draft(null)
  }

  async drop(io: Io, target: Target): Promise<void> {
    if (target.kind === 'added') {
      await this.store.saveRules(io, { ...this.store.rules, added: this.store.rules.added.filter(one => one.id !== target.name) })
      await io.set.selected(null)
      await this.tell(io, { text: `Deleted your section. ${APPLIES.added}`, isError: false })
    } else {
      await this.store.saveRules(io, withRule(this.store.rules, target.kind, target.name, { mode: 'drop' }))
      await this.tell(io, { text: target.kind === 'tool' ? "Removed: from your next message on, the model can't use it." : `Dropped: it is left out from now on. ${APPLIES[target.kind]}`, isError: false })
    }
    await io.set.draft(null)
  }

  async reset(io: Io, target: Target): Promise<void> {
    if (target.kind === 'added') {
      return
    }
    const wasRemovedTool = target.kind === 'tool' && this.store.rules.tools[target.name]?.mode === 'drop'
    await this.store.saveRules(io, withRule(this.store.rules, target.kind, target.name, undefined))
    await io.set.draft(null)
    const followed = inheritedRule(this.store.rules, target.kind, target.name)?.parent
    const back = wasRemovedTool ? 'The tool is back from your next message on.' : `${followed === undefined ? 'Back to the original.' : `Back to following your edit of ${followed}.`} ${APPLIES[target.kind]}`
    await this.tell(io, { text: back, isError: false })
  }

  async addSection(io: Io): Promise<void> {
    const id = nextAddedId(this.store.rules)
    await this.store.saveRules(io, { ...this.store.rules, added: [...this.store.rules.added, { id, text: '' }] })
    await this.open(io, { kind: 'added', name: id })
  }

  async togglePause(io: Io): Promise<void> {
    const isPaused = !this.store.rules.isPaused
    await this.store.saveRules(io, { ...this.store.rules, isPaused })
    await this.tell(io, { text: isPaused ? 'All edits are paused: everything is sent as Claude Code made it.' : 'Edits are back on.', isError: false })
  }

  async dismissNotice(io: Io): Promise<void> {
    await io.set.notice(null)
  }

  async setToolSearch(io: Io, value: string): Promise<void> {
    await io.set.toolSearch(value)
  }

  async setHistorySearch(io: Io, value: string): Promise<void> {
    await io.set.historySearch(value)
  }

  async setListSort(io: Io, value: string): Promise<void> {
    if (isListSort(value)) {
      await io.set.listSort(value)
    }
  }

  async openExchange(io: Io, n: number | null): Promise<void> {
    await this.api.open(io, n)
  }

  async toggleApiSection(io: Io, section: ApiSection): Promise<void> {
    await this.api.toggleSection(io, section)
  }

  async refreshApi(io: Io): Promise<void> {
    await this.api.load(io)
  }

  async setRecording(io: Io, isOn: boolean): Promise<void> {
    await this.tell(io, await this.api.setRecording(io, isOn))
  }

  async refreshPromptMode(io: Io): Promise<void> {
    const settings = await readSettings(io)
    await io.set.promptMode(settings === undefined ? 'unknown' : promptModeOf(settings ?? {}))
  }

  async setPromptMode(io: Io, mode: PromptMode): Promise<void> {
    const settings = await readSettings(io)
    if (settings === undefined) {
      await this.tell(io, { text: SETTINGS_UNREADABLE, isError: true })

      return
    }
    await writeSettings(io, withPromptMode(settings ?? {}, mode))
    await this.refreshPromptMode(io)
    const chosen = mode === 'full' ? 'Every model gets the full prompt' : mode === 'short' ? 'Every model gets the short prompt' : 'Claude Code picks the prompt per model again'
    await this.tell(io, { text: `${chosen} in sessions you start from now on.`, isError: false })
  }

  async setPromptView(io: Io, variant: PromptVariant): Promise<void> {
    await io.set.promptView(variant)
  }

  async loadDesktop(io: Io): Promise<void> {
    if (this.isDesktopLoaded) {
      return
    }
    this.desktop = await readDesktopAppend(io).catch(() => null)
    this.isDesktopLoaded = true
    await io.set.redraw()
  }

  async loadHistories(io: Io): Promise<void> {
    const histories = await this.readRecentHistories(io)
    this.histories = histories.map(history => ({ sessionId: history.sessionId, cwd: history.cwd, startedAt: history.startedAt, lastAt: history.lastAt, itemCount: history.items.length }))
    this.refreshChanging()
    await this.rememberFrom(io, histories)
    await io.set.redraw()
  }

  /**
   * Reads the recent sessions' histories to find the texts that change between sessions, and to remember sections and
   * context blocks the catalog lacks, so they can be edited while Claude Code does not send them.
   */
  async loadChanging(io: Io): Promise<void> {
    const histories = await this.readRecentHistories(io)
    this.refreshChanging()
    await this.rememberFrom(io, histories)
  }

  /** Whether an item's text was not always the same: it has parts that change, which a full replacement would freeze. */
  isChanging(kind: Kind, name: string, variant?: PromptVariant): boolean {
    return this.changing.has(textKey(kind, name, variant))
  }

  async openHistory(io: Io, sessionId: string | null): Promise<void> {
    this.openedHistory = sessionId === null ? null : await this.store.readHistory(io, sessionId)
    await io.set.historySession(sessionId)
    await io.set.historyItem(null)
    await io.set.historySearch('')
  }

  async openHistoryItem(io: Io, index: number | null): Promise<void> {
    const item = index === null ? undefined : this.openedHistory?.items[index]
    if (item !== undefined && !this.texts.has(item.hash)) {
      this.texts.set(item.hash, await this.store.readText(io, item.hash))
    }
    // An item opened here shows the same editor as in its own tab: it starts from what is saved, as there.
    await io.set.draft(null)
    await io.set.notice(null)
    await io.set.historyItem(index)
  }

  /** The engine's own text of an item and when it was last seen; a section's in the given prompt version, else in the latest one. */
  seen(kind: 'section' | 'context', name: string, variant?: PromptVariant): Seen | undefined {
    const catalog = this.store.catalog
    if (kind === 'context') {
      return catalog.context[name]
    }
    const shown = variant ?? catalog.lastVariant

    return shown === null ? undefined : catalog.prompts[shown]?.sections[name]
  }

  /** The engine's own text of an item, as last seen; a section's in the given prompt version, else in the latest one. */
  original(kind: Kind, name: string, variant?: PromptVariant): string | undefined {
    const catalog = this.store.catalog
    switch (kind) {
      case 'section': {
        const shown = variant ?? catalog.lastVariant

        return shown === null ? undefined : catalog.prompts[shown]?.sections[name]?.text
      }
      case 'context':
        return catalog.context[name]?.text
      case 'attachment':
        return catalog.attachments[name]?.text
      case 'tool':
        return catalog.tools[name]?.text
    }
  }

  private async tell(io: Io, next: Notice): Promise<void> {
    await io.set.notice(next)
  }

  private async editDraft(io: Io, target: Target, change: (current: Draft) => Draft): Promise<void> {
    await io.set.updateDraft(current => change(this.editorFor(target, current)))
  }

  /** The newest session histories, this session's own included as it stands in memory. */
  private async readRecentHistories(io: Io): Promise<SessionHistory[]> {
    await this.store.flush(io)
    const sessionId = await io.sessionId()
    const histories: SessionHistory[] = []
    for (const file of (await this.store.listHistories(io)).slice(0, MAX_LISTED_HISTORIES)) {
      const history = await this.store.readHistory(io, file.sessionId)
      if (history !== null) {
        histories.push(history)
      }
    }
    this.pastHistories = histories.filter(history => history.sessionId !== sessionId)

    return histories
  }

  /** Remembers the sections and context blocks of the histories the catalog lacks, each with its newest text. */
  private async rememberFrom(io: Io, histories: readonly SessionHistory[]): Promise<void> {
    const newest = new Map<string, { kind: 'section' | 'context'; name: string; variant?: PromptVariant; hash: string; lastAt: number }>()
    for (const item of histories.flatMap(history => history.items)) {
      const isSection = item.kind === 'section' && item.variant !== undefined && !item.name.startsWith(ADDED_PREFIX)
      if (!isSection && item.kind !== 'context') {
        continue
      }
      const kind = item.kind === 'section' ? 'section' : 'context'
      if (this.seen(kind, item.name, item.variant) !== undefined) {
        continue
      }
      const key = textKey(kind, item.name, item.variant)
      if ((newest.get(key)?.lastAt ?? -1) < item.lastAt) {
        newest.set(key, { kind, name: item.name, ...(item.variant === undefined ? {} : { variant: item.variant }), hash: item.hash, lastAt: item.lastAt })
      }
    }
    for (const found of newest.values()) {
      const text = await this.store.readText(io, found.hash)
      if (text !== null) {
        this.store.remember(found.kind, found.name, { text, lastAt: found.lastAt }, found.variant)
      }
    }
    if (newest.size > 0) {
      await this.store.flush(io)
    }
  }

  private refreshChanging(): void {
    this.changing = changingTexts(this.store.history === null ? this.pastHistories : [...this.pastHistories, this.store.history])
  }

}

const LIST_SORTS: readonly ListSort[] = ['natural', 'name', 'size']

/** Whether a value is a list order: a picker hands over a string, and the store anything a session saved. */
export function isListSort(value: unknown): value is ListSort {
  return LIST_SORTS.some(sort => sort === value)
}

export function draftKey(target: Target): string {
  return `${target.kind}:${target.name}`
}

/** The pairs that do something: one with nothing to find changes nothing. */
function usedPatches(patches: readonly Patch[]): Patch[] {
  return patches.filter(patch => patch.find !== '')
}

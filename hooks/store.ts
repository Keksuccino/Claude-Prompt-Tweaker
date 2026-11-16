import type { PromptComposeSection, Timer } from 'claude-code'

import type { Action, Catalog, Kind, PromptSnapshot, PromptVariant, Rules, Seen, SessionHistory } from '../types'
import { clipText, emptyCatalog, emptyHistory, mergeCatalog, recordSighting, withInferredVariants } from './history'
import type { Io } from './io'
import { emptyRules, parseRules, removedTools } from './rules'

/** How long the rules read from disk are trusted before their file is checked again: another session may have changed them. */
const RULES_CHECK_MS = 2000

/** Sightings are written in batches, at most this often, so a busy turn does not rewrite the same files on every message. */
const FLUSH_MS = 1500

export type Paths = { root: string; rules: string; catalog: string; histories: string; texts: string }

/** A session's history file, as the History tab lists it. */
export type HistoryFile = { sessionId: string; mtimeMs: number }

/**
 * Everything the mod keeps on disk, under ~/.claude/prompt-tweaker: the rules every session applies, the catalog of the
 * engine's latest originals, one history file per session, and each distinct text once, named by its SHA-256.
 * Each session process holds its own copy: rules are re-read when their file changes, the catalog is merged on every write.
 */
export class TweakerStore {

  rules: Rules = emptyRules()
  catalog: Catalog = emptyCatalog()
  history: SessionHistory | null = null

  private paths: Paths | null = null
  private rulesCheckedAt = 0
  private rulesMtime: number | undefined | null = null
  /** The removed tools as last applied, one name a line; null before the rules were first read. */
  private removedSignature: string | null = null
  private readonly knownTexts = new Set<string>()
  private flushTimer: Timer | undefined
  private isCatalogDirty = false
  private isHistoryDirty = false
  /** Serializes this process's file writes, so two flushes never interleave. */
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly onChange: (io: Io) => void) {}

  async resolvePaths(io: Io): Promise<Paths> {
    if (this.paths === null) {
      const root = `${await io.home()}/.claude/prompt-tweaker`
      this.paths = { root, rules: `${root}/rules.json`, catalog: `${root}/catalog.json`, histories: `${root}/history`, texts: `${root}/texts` }
    }

    return this.paths
  }

  async load(io: Io): Promise<void> {
    const paths = await this.resolvePaths(io)
    await this.refreshRules(io, true)
    try {
      this.catalog = mergeCatalog(asCatalog(JSON.parse(await io.readFile(paths.catalog))), this.catalog)
    } catch {
      // No catalog yet: the first prompt this session composes starts it.
    }
  }

  /** Re-reads rules.json when it changed since the last read, checking at most every few seconds unless forced. */
  async refreshRules(io: Io, isForced = false): Promise<void> {
    const now = await io.now()
    if (!isForced && now - this.rulesCheckedAt < RULES_CHECK_MS) {
      return
    }
    this.rulesCheckedAt = now
    const paths = await this.resolvePaths(io)
    const mtime = await io.mtime(paths.rules)
    if (mtime === this.rulesMtime) {
      return
    }
    this.rulesMtime = mtime
    if (mtime === undefined) {
      this.rules = emptyRules()
    } else {
      try {
        this.rules = parseRules(await io.readFile(paths.rules))
      } catch {
        // A rules file that does not parse keeps the rules last read: a half-written or hand-broken file must not drop every edit.
      }
    }
    this.onRulesChange(io)
  }

  async saveRules(io: Io, rules: Rules): Promise<void> {
    const paths = await this.resolvePaths(io)
    this.rules = rules
    await this.queue(async () => {
      await io.writeFile(paths.rules, `${JSON.stringify(rules, null, 2)}\n`)
      this.rulesMtime = await io.mtime(paths.rules)
      this.rulesCheckedAt = await io.now()
    })
    this.onRulesChange(io)
  }

  /** Redraws the panel, and has Claude Code ask for the session's tools again when the removed ones changed. */
  private onRulesChange(io: Io): void {
    const removed = removedTools(this.rules).join('\n')
    if (this.removedSignature !== null && removed !== this.removedSignature) {
      io.invalidateTools()
    }
    this.removedSignature = removed
    this.onChange(io)
  }

  /** Notes the engine's original text of a context block, injected message type or tool in the catalog. */
  noteOriginal(kind: Exclude<Kind, 'section'>, name: string, seen: Seen): void {
    const map = this.catalogMap(kind)
    const before = map[name]
    map[name] = seen
    if (before === undefined || before.text !== seen.text || before.scope !== seen.scope || before.origin !== seen.origin) {
      this.isCatalogDirty = true
    }
  }

  noteContextOrder(order: string[]): void {
    if (this.catalog.contextOrder.join('\n') !== order.join('\n')) {
      this.catalog.contextOrder = order
      this.isCatalogDirty = true
    }
  }

  /**
   * Notes a composed system prompt as the latest of its version, so the panel lists that version's sections as sent. The
   * sections it lacks stay remembered with their last text.
   */
  notePrompt(variant: PromptVariant, model: string, sections: readonly PromptComposeSection[], at: number): void {
    const snapshot: PromptSnapshot = { order: sections.map(section => section.id), sections: { ...this.catalog.prompts[variant]?.sections }, model, lastAt: at }
    for (const section of sections) {
      snapshot.sections[section.id] = { text: section.text, scope: section.scope, lastAt: at }
    }
    this.catalog.prompts[variant] = snapshot
    this.catalog.lastVariant = variant
    this.isCatalogDirty = true
  }

  /**
   * Remembers an item's text from an older sighting the catalog lacks, as read back from a history. A section of a version
   * no prompt has been noted in yet starts that version with an empty order: none of its sections was in a latest prompt.
   */
  remember(kind: 'section' | 'context', name: string, seen: Seen, variant?: PromptVariant): void {
    if (kind === 'context') {
      if (this.catalog.context[name] === undefined) {
        this.catalog.context[name] = seen
        this.isCatalogDirty = true
      }

      return
    }
    if (variant === undefined) {
      return
    }
    const snapshot = this.catalog.prompts[variant] ?? { order: [], sections: {}, model: '', lastAt: 0 }
    if (snapshot.sections[name] === undefined) {
      this.catalog.prompts[variant] = { ...snapshot, sections: { ...snapshot.sections, [name]: seen } }
      this.isCatalogDirty = true
    }
  }

  /** Records that the model was sent (or spared) one item's text in this session, keeping the text itself once on disk. */
  async recordSighting(io: Io, kind: Kind, name: string, text: string, action: Action, where: { agentId?: string; variant?: PromptVariant }): Promise<void> {
    const history = await this.sessionHistory(io)
    const hash = await sha256(text)
    await this.storeText(io, hash, text)
    const extra = { ...(where.agentId === undefined ? {} : { agentId: where.agentId }), ...(where.variant === undefined ? {} : { variant: where.variant }) }
    recordSighting(history, { kind, name, hash, length: text.length, action, ...extra }, await io.now())
    this.isHistoryDirty = true
    this.scheduleFlush(io)
  }

  scheduleFlush(io: Io): void {
    if (this.flushTimer !== undefined || (!this.isCatalogDirty && !this.isHistoryDirty)) {
      return
    }
    this.flushTimer = io.after(FLUSH_MS, () => {
      this.flushTimer = undefined
      void this.flush(io)
    })
  }

  async flush(io: Io): Promise<void> {
    if (!this.isCatalogDirty && !this.isHistoryDirty) {
      return
    }
    const paths = await this.resolvePaths(io)
    await this.queue(async () => {
      if (this.isCatalogDirty) {
        this.isCatalogDirty = false
        let stored = emptyCatalog()
        try {
          stored = asCatalog(JSON.parse(await io.readFile(paths.catalog)))
        } catch {
          // No catalog yet, or one another session is writing: this session's view stands alone.
        }
        this.catalog = mergeCatalog(stored, this.catalog)
        await io.writeFile(paths.catalog, JSON.stringify(this.catalog))
      }
      if (this.isHistoryDirty && this.history !== null) {
        this.isHistoryDirty = false
        await io.writeFile(`${paths.histories}/${this.history.sessionId}.json`, JSON.stringify(this.history))
      }
    })
    this.onChange(io)
  }

  async listHistories(io: Io): Promise<HistoryFile[]> {
    const paths = await this.resolvePaths(io)
    const entries = await io.listDir(paths.histories).catch(() => [])

    return entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map(entry => ({ sessionId: entry.name.slice(0, -'.json'.length), mtimeMs: entry.mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  async readHistory(io: Io, sessionId: string): Promise<SessionHistory | null> {
    if (this.history?.sessionId === sessionId) {
      return this.history
    }
    const paths = await this.resolvePaths(io)
    try {
      return asHistory(JSON.parse(await io.readFile(`${paths.histories}/${sessionId}.json`)))
    } catch {
      return null
    }
  }

  async readText(io: Io, hash: string): Promise<string | null> {
    const paths = await this.resolvePaths(io)

    return io.readFile(textPath(paths, hash)).catch(() => null)
  }

  private async sessionHistory(io: Io): Promise<SessionHistory> {
    const sessionId = await io.sessionId()
    if (this.history?.sessionId === sessionId) {
      return this.history
    }
    // A resumed session continues the history it started; a reload of the mod continues this process's.
    const stored = await this.readHistory(io, sessionId)
    this.history = stored ?? emptyHistory(sessionId, await io.cwd(), await io.now())

    return this.history
  }

  private async storeText(io: Io, hash: string, text: string): Promise<void> {
    if (this.knownTexts.has(hash)) {
      return
    }
    const path = textPath(await this.resolvePaths(io), hash)
    if (!(await io.exists(path))) {
      await io.writeFile(path, clipText(text))
    }
    this.knownTexts.add(hash)
  }

  private catalogMap(kind: Exclude<Kind, 'section'>): Record<string, Seen> {
    switch (kind) {
      case 'context':
        return this.catalog.context
      case 'attachment':
        return this.catalog.attachments
      case 'tool':
        return this.catalog.tools
    }
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const run = this.writing.then(work)
    // A failed write must not block every later one; the next flush writes the current state again.
    this.writing = run.catch(() => undefined)

    return run
  }

}

/** Texts are spread over 256 folders by their hash's first two characters, so no folder grows past a few thousand files. */
function textPath(paths: Paths, hash: string): string {
  return `${paths.texts}/${hash.slice(0, 2)}/${hash}.txt`
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function asCatalog(value: unknown): Catalog {
  const catalog = emptyCatalog()
  if (typeof value !== 'object' || value === null) {
    return catalog
  }
  const raw = value as Partial<Catalog> & LegacyCatalog
  const prompts = raw.prompts ?? {}
  // A catalog of the first release holds one prompt, of whichever version was composed last: it is read as that version's snapshot.
  if (raw.prompts === undefined && raw.promptVariant !== undefined && raw.promptVariant !== null && raw.sections !== undefined && Array.isArray(raw.sectionOrder)) {
    const lastAt = Math.max(0, ...Object.values(raw.sections).map(seen => seen.lastAt))
    prompts[raw.promptVariant] = { order: raw.sectionOrder, sections: raw.sections, model: raw.model ?? '', lastAt }
  }

  return {
    ...catalog,
    prompts,
    lastVariant: raw.lastVariant ?? raw.promptVariant ?? null,
    context: raw.context ?? {},
    contextOrder: Array.isArray(raw.contextOrder) ? raw.contextOrder : [],
    attachments: raw.attachments ?? {},
    tools: raw.tools ?? {},
  }
}

/** The fields a first-release catalog has in place of `prompts`. */
type LegacyCatalog = { sections?: Record<string, Seen>; sectionOrder?: string[]; promptVariant?: PromptVariant | null; model?: string | null }

function asHistory(value: unknown): SessionHistory | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as Omit<Partial<SessionHistory>, 'version'> & { version?: number }
  if (typeof raw.sessionId !== 'string' || !Array.isArray(raw.items)) {
    return null
  }
  // A first-release history counted a message again each time Claude Code asked about it, on every resume and reload: its
  // counts are unknown, and stay so as the session goes on. Its sections lack their prompt version, also once a session
  // that kept going wrote it in the current form.
  const items = withInferredVariants(raw.version === 2 ? raw.items : raw.items.map(item => ({ ...item, count: 0 })))

  return { version: 2, sessionId: raw.sessionId, cwd: raw.cwd ?? '', startedAt: raw.startedAt ?? 0, lastAt: raw.lastAt ?? 0, items }
}

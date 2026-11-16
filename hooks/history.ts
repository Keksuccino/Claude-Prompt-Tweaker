import type { Catalog, HistoryItem, Kind, PromptVariant, Seen, SessionHistory } from '../types'

/** What a session's history holds at most; past it the item seen longest ago gives way. */
export const MAX_HISTORY_ITEMS = 4000

/** The longest text kept for one item: a whole injected file can be megabytes, and the history is for reading. */
export const MAX_TEXT_LENGTH = 256 * 1024

export function emptyHistory(sessionId: string, cwd: string, at: number): SessionHistory {
  return { version: 2, sessionId, cwd, startedAt: at, lastAt: at, items: [] }
}

export function emptyCatalog(): Catalog {
  return { version: 1, prompts: {}, lastVariant: null, context: {}, contextOrder: [], attachments: {}, tools: {} }
}

const VARIANTS: readonly PromptVariant[] = ['full', 'lean', 'bare']

/**
 * Records one sighting of an item's text: a repeat of the same text and outcome moves its last time, anything else is a new
 * item. Only injected messages are counted, each sighting of one being a message added to the conversation (see
 * `HistoryItem.count`); a count that is unknown stays unknown.
 */
export function recordSighting(history: SessionHistory, seen: Omit<HistoryItem, 'firstAt' | 'lastAt' | 'count'>, at: number): void {
  history.lastAt = at
  const isCounted = seen.kind === 'attachment'
  const same = history.items.find(item => item.kind === seen.kind && item.name === seen.name && item.hash === seen.hash && item.action === seen.action && item.agentId === seen.agentId && item.variant === seen.variant)
  if (same !== undefined) {
    if (isCounted && same.count > 0) {
      same.count += 1
    }
    same.lastAt = at

    return
  }
  history.items.push({ ...seen, firstAt: at, lastAt: at, count: isCounted ? 1 : 0 })
  if (history.items.length > MAX_HISTORY_ITEMS) {
    let oldest = 0
    history.items.forEach((item, index) => {
      if (item.lastAt < (history.items[oldest]?.lastAt ?? Infinity)) {
        oldest = index
      }
    })
    history.items.splice(oldest, 1)
  }
}

/** The section each prompt version opens with, and none other has: what tells a version apart in a history without them. */
const OPENING_SECTIONS: readonly [string, PromptVariant][] = [
  ['lean_body', 'lean'],
  ['intro', 'full'],
]

/**
 * Gives the sections of a first-release history the prompt version they were sent in, which those histories did not keep.
 * When the sections without a version include exactly one version's opening section, they were all of that version;
 * otherwise (none, or both, as when the prompt mode changed mid-session) they stay without one.
 */
export function withInferredVariants(items: readonly HistoryItem[]): HistoryItem[] {
  const unplaced = new Set(items.filter(item => item.kind === 'section' && item.variant === undefined).map(item => item.name))
  const found = OPENING_SECTIONS.filter(([name]) => unplaced.has(name))
  const variant = found.length === 1 ? found[0]?.[1] : undefined
  if (variant === undefined) {
    return [...items]
  }

  return items.map(item => (item.kind === 'section' && item.variant === undefined ? { ...item, variant } : item))
}

/** The key an item's texts are compared under: a section's in each prompt version apart, since the versions word some alike sections differently. */
export function textKey(kind: Kind, name: string, variant?: PromptVariant): string {
  return `${kind}:${variant ?? ''}:${name}`
}

/** The items whose engine text was not the same every time it was seen, across the given histories: their text has parts that change. */
export function changingTexts(histories: readonly SessionHistory[]): Set<string> {
  const hashes = new Map<string, Set<string>>()
  for (const history of histories) {
    for (const item of history.items) {
      const key = textKey(item.kind, item.name, item.variant)
      const seen = hashes.get(key) ?? new Set<string>()
      seen.add(item.hash)
      hashes.set(key, seen)
    }
  }

  return new Set([...hashes].filter(([, seen]) => seen.size > 1).map(([key]) => key))
}

/** Keeps the text a history file stores bounded, saying how much was left out. */
export function clipText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) {
    return text
  }

  return `${text.slice(0, MAX_TEXT_LENGTH)}\n\n[Claude Tweaker kept the first ${MAX_TEXT_LENGTH} of ${text.length} characters]`
}

/**
 * Merges what this session saw into the catalog another session may have written meanwhile: per item the later sighting wins,
 * per prompt version the later composed prompt's order, model and time win, and the sections both sides remember are kept.
 */
export function mergeCatalog(stored: Catalog, ours: Catalog): Catalog {
  const prompts: Catalog['prompts'] = {}
  let lastVariant: PromptVariant | null = null
  let lastAt = -1
  for (const variant of VARIANTS) {
    const mine = ours.prompts[variant]
    const theirs = stored.prompts[variant]
    const newer = mine !== undefined && (theirs === undefined || mine.lastAt >= theirs.lastAt) ? mine : theirs
    if (newer !== undefined) {
      const older = newer === mine ? theirs : mine
      // The newer prompt's order stands; the sections either side remembers are all kept.
      prompts[variant] = { ...newer, sections: mergeSeen(older?.sections ?? {}, newer.sections) }
      if (newer.lastAt > lastAt) {
        lastAt = newer.lastAt
        lastVariant = variant
      }
    }
  }
  const isOurContextNewer = newest(ours.context) >= newest(stored.context) && ours.contextOrder.length > 0

  return {
    version: 1,
    prompts,
    lastVariant,
    context: mergeSeen(stored.context, ours.context),
    contextOrder: isOurContextNewer ? ours.contextOrder : stored.contextOrder,
    attachments: mergeSeen(stored.attachments, ours.attachments),
    tools: mergeSeen(stored.tools, ours.tools),
  }
}

function mergeSeen(stored: Record<string, Seen>, ours: Record<string, Seen>): Record<string, Seen> {
  const result = { ...stored }
  for (const [name, seen] of Object.entries(ours)) {
    const before = result[name]
    if (before === undefined || before.lastAt <= seen.lastAt) {
      result[name] = seen
    }
  }

  return result
}

function newest(map: Record<string, Seen>): number {
  let latest = 0
  for (const seen of Object.values(map)) {
    latest = Math.max(latest, seen.lastAt)
  }

  return latest
}

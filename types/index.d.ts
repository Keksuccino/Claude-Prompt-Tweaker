/** The tabs of the panel. */
export type Tab = 'prompt' | 'context' | 'injected' | 'tools' | 'desktop' | 'history' | 'api'

/** What the engine sends that a rule can change: a system prompt section, a first-message context block, an injected message type, a tool description. */
export type Kind = 'section' | 'context' | 'attachment' | 'tool'

/** One find-and-replace pair: every occurrence of `find`, as written, is replaced by `replace`. */
export type Patch = { find: string; replace: string }

/**
 * `drop` leaves the item out. `replace` sends `text` in its place, with `{{original}}` standing for the engine's current text.
 * `patch` applies its pairs to the engine's current text every time, so the parts that change between sessions stay current.
 */
export type Rule = { mode: 'drop' } | { mode: 'replace'; text: string } | { mode: 'patch'; patches: Patch[] }

export type RuleMode = Rule['mode']

/** How the editor changes an item: one full replacement text, or find-and-replace pairs. */
export type EditMode = 'full' | 'patch'

/** A section of the user's own, appended after the engine's sections. */
export type AddedSection = { id: string; text: string }

/** Everything the user changed, kept in rules.json and shared by every session. */
export type Rules = {
  version: 1
  /** Turns every rule off at once without losing them. */
  isPaused: boolean
  sections: Record<string, Rule>
  added: AddedSection[]
  context: Record<string, Rule>
  attachments: Record<string, Rule>
  tools: Record<string, Rule>
}

/** The engine's own text of an item, as last seen in any session. */
export type Seen = { text: string; origin?: string; scope?: 'shared' | 'session'; lastAt: number }

/** Which version of its system prompt Claude Code composed: the full one, the short (lean) one, or `--bare`'s one line. */
export type PromptVariant = 'full' | 'lean' | 'bare'

/**
 * One prompt version: the latest composed prompt's section ids in the order they were sent, its model and time, and every
 * section ever seen in this version with its latest text. Some sections are sent only for some models, modes or features,
 * so `sections` keeps those `order` lacks, for the user to edit before they come back.
 */
export type PromptSnapshot = { order: string[]; sections: Record<string, Seen>; model: string; lastAt: number }

/** The latest engine originals of everything a rule can change, kept in catalog.json. */
export type Catalog = {
  version: 1
  /** Each version keeps its own originals: a section both versions have can read differently in each. */
  prompts: Partial<Record<PromptVariant, PromptSnapshot>>
  /** The version the latest composed prompt was in. */
  lastVariant: PromptVariant | null
  context: Record<string, Seen>
  contextOrder: string[]
  attachments: Record<string, Seen>
  tools: Record<string, Seen>
}

/** What the mod did with an item before it reached the model; `added` is one of the user's own sections. */
export type Action = 'sent' | 'edited' | 'dropped' | 'added'

/** One distinct text of one item in one session; a repeat moves `lastAt`, and raises `count` where it counts. */
export type HistoryItem = {
  kind: Kind
  name: string
  /** The SHA-256 of the engine's text, the name of its file in texts/. */
  hash: string
  length: number
  action: Action
  agentId?: string
  /** The prompt version a section was sent in: the same section can read differently in each. */
  variant?: PromptVariant
  firstAt: number
  lastAt: number
  /**
   * How many times an injected message with this text was added to the conversation. 0 where nothing is counted: a system
   * prompt section or context block is seen each time Claude Code builds it, which says nothing about how often it was sent,
   * and the first histories counted every time Claude Code asked about a message again, so their counts are unknown.
   */
  count: number
}

/** Version 2 counts each injected message once, as it is added to the conversation. */
export type SessionHistory = { version: 2; sessionId: string; cwd: string; startedAt: number; lastAt: number; items: HistoryItem[] }

/** The item a list opened in the detail view. `added` is one of the user's own sections; a section names the version it was opened from. */
export type Target = { kind: Kind | 'added'; name: string; variant?: PromptVariant }

/** Unsaved editor content, keyed by the target it belongs to. Both modes keep their content, so switching back loses nothing. */
export type Draft = { key: string; mode: EditMode; text: string; patches: Patch[] }

export type Notice = { text: string; isError: boolean }

/** Which system prompt ~/.claude/settings.json asks Claude Code for: its per-model default, always the full one, or always the short one. */
export type PromptMode = 'default' | 'full' | 'short'

/**
 * How the panel orders its lists: in the list's own order (as Claude Code sends them, or by time in a history), by name, or
 * by length with the longest first. A list whose own order is by name shows `natural` as `name`.
 */
export type ListSort = 'natural' | 'name' | 'size'

/** What recorder.sh leaves in ~/.claude/prompt-tweaker/recorder.json: where it keeps recordings and how sessions reach it. */
export type RecorderInfo = { dir: string; port: number; proxy: string; ca: string }

/** Token counts of one response, as the API reports them; `input` leaves out what the cache read or wrote. */
export type Usage = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }

/** One exchange with the API as a line of a session's index.jsonl sums it up. */
export type ExchangeSummary = {
  n: number
  /** When the request started, in milliseconds. */
  at: number
  durationMs: number
  method: string
  path: string
  /** The response's HTTP status; null when none came. */
  status: number | null
  /** Why the exchange broke off, when it did. */
  error: string | null
  requestBytes: number
  responseBytes: number
  model: string | null
  /** How many messages the request carried. */
  messages: number | null
  isStream: boolean
  usage: Usage | null
  stopReason: string | null
  /** The API's error type, for a response that is one. */
  errorType: string | null
}

/**
 * A request body as record.py keeps it: its own fields inline, and the system prompt, the tool list and each message as
 * the SHA-256 of a blob, stored once however many requests send it. A body that is no JSON object is one blob, `text`.
 */
export type StoredBody = { order?: string[]; fields?: Record<string, unknown>; system?: string; tools?: string; messages?: string[]; text?: string }

/** One exchange as its file keeps it: the summary, the headers without secrets, and the bodies as blob references. */
export type Exchange = ExchangeSummary & {
  request: { headers: [string, string][]; body: StoredBody }
  response: { headers: [string, string][]; body: string | null }
}

/** The parts of an exchange's detail view that open and close. */
export type ApiSection = 'headers' | 'fields' | 'system' | 'tools' | 'newMessages' | 'allMessages' | 'response'

/** The prompt mode as read from the settings file; `unknown` while that file cannot be read. */
export type PromptModeState = PromptMode | 'unknown'

declare module 'claude-code' {
  interface PluginState {
    'prompt-tweaker': {
      tab: Tab
      selected: Target | null
      draft: Draft | null
      toolSearch: string
      historySession: string | null
      historyItem: number | null
      historySearch: string
      /** Raised whenever the rules, the catalog or a history file change, so every drawing that shows them redraws. */
      rev: number
      notice: Notice | null
      promptMode: PromptModeState
      /** The prompt version the System prompt tab lists; null follows the latest composed one. */
      promptView: PromptVariant | null
      /** The order of every list in the panel, one choice for all tabs; kept for later sessions in the mod's store. */
      listSort: ListSort
      /** The exchange the API Traffic tab shows in full, by its number in the session; null lists them all. */
      apiItem: number | null
      /** The parts of that exchange shown open. */
      apiExpanded: ApiSection[]
    }
  }
}

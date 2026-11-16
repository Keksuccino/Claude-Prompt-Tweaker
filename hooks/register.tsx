import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptAttachmentOrigin, PromptComposeTrait, Register } from 'claude-code'

import type { PromptVariant } from '../types'
import { isListSort, TweakerController } from './controller'
import { injectedName, injectedText } from './injected'
import type { Io } from './io'
import { PANEL_TITLE, renderBandLine, renderBandRow, renderPane } from './pane'
import { activeRule, ADDED_PREFIX, applyRule, composeSections, keptTools } from './rules'
import { TweakerStore } from './store'

/** The mod's name, as plugin.json gives it: how the band above the prompt tells this mod's row apart from the others. */
const PLUGIN = 'prompt-tweaker'

/** The panel's id: `$.ui.open` opens it, and its `ui.render` hook matches it. */
const PANE = 'prompt-tweaker'

/** The key of the list order in the mod's store, which outlives the session. */
const LIST_SORT_KEY = 'listSort'

// The panel's $.state values. The engine reads which values a module uses off these declarations, so they live in this file.
const tab = atom({ plugin: 'prompt-tweaker', key: 'tab' } as const, 'prompt')
const selected = atom({ plugin: 'prompt-tweaker', key: 'selected' } as const, null)
const draft = atom({ plugin: 'prompt-tweaker', key: 'draft' } as const, null)
const toolSearch = atom({ plugin: 'prompt-tweaker', key: 'toolSearch' } as const, '')
const historySession = atom({ plugin: 'prompt-tweaker', key: 'historySession' } as const, null)
const historyItem = atom({ plugin: 'prompt-tweaker', key: 'historyItem' } as const, null)
const historySearch = atom({ plugin: 'prompt-tweaker', key: 'historySearch' } as const, '')
const rev = atom({ plugin: 'prompt-tweaker', key: 'rev' } as const, 0)
const notice = atom({ plugin: 'prompt-tweaker', key: 'notice' } as const, null)
const promptMode = atom({ plugin: 'prompt-tweaker', key: 'promptMode' } as const, 'unknown')
const promptView = atom({ plugin: 'prompt-tweaker', key: 'promptView' } as const, null)
const listSort = atom({ plugin: 'prompt-tweaker', key: 'listSort' } as const, 'natural')
const apiItem = atom({ plugin: 'prompt-tweaker', key: 'apiItem' } as const, null)
const apiExpanded = atom({ plugin: 'prompt-tweaker', key: 'apiExpanded' } as const, [])

export const register: Register = on => {
  const store = new TweakerStore(io => void io.set.redraw())
  const control = new TweakerController(store)

  /** Records one injected message as it is added to the conversation, with what the rules make of it for the model. */
  async function recordInjected(io: Io, type: string, text: string, agentId: string | undefined): Promise<void> {
    await store.refreshRules(io)
    const name = injectedName(type, text)
    const applied = applyRule(text, activeRule(store.rules, 'attachment', name))
    await store.recordSighting(io, 'attachment', name, text, applied.action, agentId === undefined ? {} : { agentId })
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const io = bind($)
    await store.load(io)
    await $.command.register({ name: 'tweaker', description: 'Open Claude Tweaker: see and edit what Claude Code sends the model' })
    const savedSort = await $.store.get(LIST_SORT_KEY)
    if (isListSort(savedSort)) {
      await update($, listSort, () => savedSort)
    }
    void control.refreshPromptMode(io)

    return started
  })

  on('command.run', { command: 'tweaker' }, async $ => {
    await openPanel($, control)

    return { text: 'Opened Claude Tweaker.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => (e.props.hasSurvey || e.surface === 'mobile' ? next(e) : renderBandRow($.ui.resolve({ ...e, surface: e.surface }), () => void openPanel($, control))))

  // The band stacks one row per mod. With other rows there, this one is taken out and its button drawn after them, at the
  // right end of the same line, so it adds no line of its own.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const others = e.props.rows.filter(row => row.plugin !== PLUGIN)
    if (e.props.hasSurvey || e.surface === 'mobile' || others.length === e.props.rows.length || others.length === 0) {
      return next(e)
    }
    const stacked = await next({ ...e, props: { ...e.props, rows: others } })

    return renderBandLine($.ui.resolve({ ...e, surface: e.surface }), stacked, () => void openPanel($, control))
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const io = bind($)
    await store.refreshRules(io)
    const { sections, actions } = composeSections(composed.sections, store.rules)
    // `/context` composes a prompt only to measure it: the rules apply so it measures what is sent, but nothing is recorded.
    if (!e.traits.includes('analysis')) {
      const variant = variantOf(e.traits)
      store.notePrompt(variant, e.model, composed.sections, await $.clock.now())
      for (const section of composed.sections) {
        await store.recordSighting(io, 'section', section.id, section.text, actions.get(section.id) ?? 'sent', { variant })
      }
      for (const section of sections) {
        if (section.id.startsWith(ADDED_PREFIX)) {
          await store.recordSighting(io, 'section', section.id, section.text, 'added', { variant })
        }
      }
      store.scheduleFlush(io)
    }

    return { sections }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const io = bind($)
    await store.refreshRules(io)
    const at = await $.clock.now()
    store.noteContextOrder(result.blocks.map(block => block.name))
    const blocks = []
    let isChanged = false
    for (const block of result.blocks) {
      const applied = applyRule(block.text, activeRule(store.rules, 'context', block.name))
      store.noteOriginal('context', block.name, { text: block.text, lastAt: at })
      await store.recordSighting(io, 'context', block.name, block.text, applied.action, {})
      if (applied.text !== null) {
        blocks.push(applied.text === block.text ? block : { ...block, text: applied.text })
      }
      isChanged ||= applied.text !== block.text
    }
    store.scheduleFlush(io)

    // Unchanged, the files behind the CLAUDE.md block pass on as they came; changed, the engine marks them unknown itself.
    return isChanged ? { blocks } : result
  })

  // Claude Code asks this again for every message the conversation holds whenever a process resumes it or the mod reloads,
  // so it applies the rules and keeps the catalog, and `session.append` below counts the messages.
  on('prompt.attachment', async ($, e, next) => {
    const result = await next(e)
    if (result.text === null) {
      return result
    }
    const io = bind($)
    await store.refreshRules(io)
    const name = injectedName(e.type, result.text)
    const applied = applyRule(result.text, activeRule(store.rules, 'attachment', name))
    store.noteOriginal('attachment', name, { text: result.text, origin: originLabel(e.origin), lastAt: await $.clock.now() })
    store.scheduleFlush(io)

    return applied.text === result.text ? result : { ...result, text: applied.text }
  })

  // Fires once for each message Claude Code injects, as the conversation stores it: the one place to count them. The row is
  // stored as Claude Code made it; `prompt.attachment` changes what the model reads of it.
  on('session.append', { message: { type: 'attachment' } }, async ($, e, next) => {
    const stored = await next(e)
    if (stored.deny !== undefined) {
      return stored
    }
    const text = injectedText(stored.message.content)
    // A row no request carries, or one without text, never reaches the model.
    if (stored.message.role !== undefined && text !== '') {
      // The history must never get in the way of storing the conversation: a failure only leaves this message out of it.
      await recordInjected(bind($), stored.message.name ?? '', text, e.agentId).catch(() => undefined)
    }

    return stored
  })

  on('tool.describe', async ($, e, next) => {
    const result = await next(e)
    const io = bind($)
    await store.refreshRules(io)
    store.noteOriginal('tool', e.tool, { text: result.description, origin: e.provider.plugin, lastAt: await $.clock.now() })
    store.scheduleFlush(io)
    const rule = activeRule(store.rules, 'tool', e.tool)
    // A removed tool leaves through `tool.list` below; its description stays as Claude Code made it.
    const applied = rule?.mode === 'drop' ? undefined : applyRule(result.description, rule).text

    // A tool cannot be left out through its description, so an edit that empties it sends the engine's own instead.
    return applied === undefined || applied === null || applied.trim() === '' || applied === result.description ? result : { ...result, description: applied }
  })

  // The session's tool pool: a tool the user removed is gone for the model, its agents and every other caller. Claude Code
  // asks once per thread and when the store invalidates it, never per turn, so the prompt cache holds.
  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value === undefined) {
      return listed
    }
    await store.refreshRules(bind($))

    return { value: keptTools(listed.value, store.rules) }
  })

  // The recorder writes an exchange once its response ended: the API Traffic tab reads its list again after each turn.
  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    control.api.refreshAfterTurn(bind($))

    return completed
  })

  on('session.end', async ($, e, next) => {
    await store.flush(bind($))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)

      return <Text>Claude Tweaker opens in the desktop app or a terminal.</Text>
    }
    // Rules, catalog and history live outside $.state: reading `rev` subscribes the panel to every change of them. Drawing
    // must not write state, so the rules are not re-read here (that redraws): every hook, opening the panel and switching
    // tabs re-read them.
    await read($, rev)
    const io = bind($)
    const state = {
      tab: await read($, tab),
      selected: await read($, selected),
      draft: await read($, draft),
      notice: await read($, notice),
      promptMode: await read($, promptMode),
      promptView: await read($, promptView),
      toolSearch: await read($, toolSearch),
      historySession: await read($, historySession),
      historyItem: await read($, historyItem),
      historySearch: await read($, historySearch),
      listSort: await read($, listSort),
      apiItem: await read($, apiItem),
      apiExpanded: await read($, apiExpanded),
    }

    return renderPane($.ui.resolve({ ...e, surface: e.surface }), state, io, control)
  })
}

/** Opens the panel, for `/tweaker` and the button above the prompt, with what it shows read fresh. */
async function openPanel($: EngineInterface, control: TweakerController): Promise<void> {
  const io = bind($)
  await control.store.refreshRules(io)
  await control.refreshPromptMode(io)
  await control.loadChanging(io)
  await $.ui.open({ id: PANE, title: PANEL_TITLE })
}

/**
 * The closures the other modules reach the engine through, over this hook's `$`. A drawing's buttons keep the closures of
 * the render that drew them, so their `$` stays usable after that render returned, as a timer's does.
 */
function bind($: EngineInterface): Io {
  return {
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    home: async () => (await $.env.get('HOME')) ?? '',
    sessionId: () => $.session.id(),
    cwd: () => $.session.cwd(),
    readFile: path => $.fs.read(path),
    writeFile: (path, text) => $.fs.write(path, text),
    listDir: path => $.fs.list(path),
    exists: path => $.fs.exists(path),
    mtime: async path => (await $.fs.stat(path).catch(() => undefined))?.mtimeMs,
    invalidateTools: () => $.ui.invalidate('tool.list'),
    run: argv => $.process.run(argv, { timeoutMs: 60_000 }),
    pluginRoot: () => $.plugin.root,
    getDraft: () => read($, draft),
    set: {
      tab: async value => void (await update($, tab, () => value)),
      selected: async value => void (await update($, selected, () => value)),
      draft: async value => void (await update($, draft, () => value)),
      updateDraft: async change => void (await update($, draft, change)),
      notice: async value => void (await update($, notice, () => value)),
      promptMode: async value => void (await update($, promptMode, () => value)),
      promptView: async value => void (await update($, promptView, () => value)),
      toolSearch: async value => void (await update($, toolSearch, () => value)),
      historySession: async value => void (await update($, historySession, () => value)),
      historyItem: async value => void (await update($, historyItem, () => value)),
      historySearch: async value => void (await update($, historySearch, () => value)),
      listSort: async value => {
        await update($, listSort, () => value)
        await $.store.set(LIST_SORT_KEY, value)
      },
      apiItem: async value => void (await update($, apiItem, () => value)),
      apiExpanded: async value => void (await update($, apiExpanded, () => value)),
      updateApiExpanded: async change => void (await update($, apiExpanded, change)),
      redraw: async () => void (await update($, rev, count => count + 1)),
    },
  }
}

function variantOf(traits: readonly PromptComposeTrait[]): PromptVariant {
  return traits.includes('bare') ? 'bare' : traits.includes('lean') ? 'lean' : 'full'
}

function originLabel(origin: PromptAttachmentOrigin): string {
  return origin.kind === 'engine' ? 'Claude Code' : origin.kind === 'hook' ? `settings hook (${origin.event})` : `plugin (${origin.event})`
}

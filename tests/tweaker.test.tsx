import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { FsEntry, On, PaneOpenArgs, PromptComposeSection, RenderElement } from 'claude-code'

import { REREAD_INSTRUCTIONS } from '../hooks/injected'
import { sha256 } from '../hooks/store'

const HOME = '/home/test'
const ROOT = `${HOME}/.claude/prompt-tweaker`
const SETTINGS = `${HOME}/.claude/settings.json`
const SURFACES = ['terminal', 'desktop'] as const

const SECTIONS: PromptComposeSection[] = [
  { id: 'lean_body', text: 'You are an agent.', scope: 'shared' },
  { id: 'memory', text: 'Memory rules.', scope: 'session' },
]

/** What the engine composes when a session gets the full prompt: other opening sections, and a shared section worded differently. */
const FULL_SECTIONS: PromptComposeSection[] = [
  { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
  { id: 'doing_tasks', text: 'Doing tasks.', scope: 'shared' },
  { id: 'memory', text: 'Memory rules, long form.', scope: 'session' },
]

/** What the engine composes a prompt for: the facts a `prompt.compose` call carries. */
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: ['lean'] } as const

const COMPOSE_FULL = { ...COMPOSE, traits: [] } as const

const PANE_PROPS = { title: 'Claude Tweaker', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

/** A file system in memory, with a clock of its own for modification times. */
class FakeFiles {

  readonly files = new Map<string, { text: string; mtimeMs: number }>()
  private tick = 1

  write(path: string, text: string): void {
    this.files.set(path, { text, mtimeMs: (this.tick += 1) })
  }

  read(path: string): string {
    const file = this.files.get(path)
    if (file === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }

    return file.text
  }

  list(path: string): FsEntry[] {
    const prefix = `${path}/`
    const names = new Map<string, FsEntry>()
    for (const [file, { text, mtimeMs }] of this.files) {
      if (!file.startsWith(prefix)) {
        continue
      }
      const rest = file.slice(prefix.length)
      const slash = rest.indexOf('/')
      const name = slash === -1 ? rest : rest.slice(0, slash)
      names.set(name, slash === -1 ? { name, kind: 'file', size: text.length, mtimeMs, isLink: false } : { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    }

    return [...names.values()]
  }

}

/** Every pane open the mod asked for, and every cached answer it had Claude Code drop. */
type Panes = { opened: PaneOpenArgs[]; invalidated: string[] }

/** Answers everything beneath the mod: the files, the session, the clock, and the engine's own prompt and attachments. */
function fakeHost(on: On, stored: Readonly<Record<string, unknown>> = {}): { files: FakeFiles; clock: MockClock; engine: { memory: string; extra: PromptComposeSection[] }; store: Map<string, unknown>; panes: Panes } {
  // The short prompt's memory section, which the engine words for each project, and the sections it adds only sometimes:
  // a test changes them between composes.
  const engine = { memory: 'Memory rules.', extra: [] as PromptComposeSection[] }
  const files = new FakeFiles()
  const clock = mock.clock(on)
  // The mod's own store, which outlives a session: a test reads what was kept in it.
  const store = new Map<string, unknown>(Object.entries(stored))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ value: files.read(e.path) }))
  on('fs.write', ($, e) => {
    files.write(e.path, e.text)

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const file = files.files.get(e.path)
    if (file === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', ($, e) => ({ value: files.list(e.path) }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/project' }))
  on('command.register', () => ({ value: { command: 'tweaker' } }))
  const panes: Panes = { opened: [], invalidated: [] }
  on('ui.invalidate', ($, e) => {
    panes.invalidated.push(e.event)

    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    panes.opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', ($, e) => ({ sections: e.traits.includes('lean') ? [...SECTIONS.map(section => (section.id === 'memory' ? { ...section, text: engine.memory } : section)), ...engine.extra] : FULL_SECTIONS }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('tool.describe', ($, e) => ({ description: e.description }))

  return { files, clock, engine, store, panes }
}

async function start($: Engine, clock: MockClock): Promise<void> {
  await $.session.start({ cwd: '/work/project', surface: 'desktop', isInteractive: true })
  await clock.settle()
}

const ENGINE = { kind: 'engine' } as const

/** The two `instructions` messages, as Claude Code words them: the one a conversation starts with, and a re-read copy. */
const START_INSTRUCTIONS = 'Codebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nRules.'
const REREAD_COPY = 'Instruction files were re-read when this session started; these differ from their earlier copies \u2014 each replaces its earlier copy:\n\nNew rules.'

let rowNumber = 0

/** Stores an injected message as Claude Code does: an attachment row of its type, its text wrapped in a system reminder. */
async function inject($: Engine, type: string, text: string): Promise<void> {
  rowNumber += 1
  await $.session.append({ message: { type: 'attachment', name: type, role: 'user', isMeta: true, content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] }, door: 'attachment', origin: ENGINE, uuid: `row-${rowNumber}` })
}

function readHistory(files: FakeFiles): { version: number; items: { kind: string; name: string; hash: string; action: string; count: number }[] } {
  return JSON.parse(files.read(`${ROOT}/history/session-1.json`))
}

function writeRules(files: FakeFiles, rules: object): void {
  files.write(`${ROOT}/rules.json`, JSON.stringify({ version: 1, isPaused: false, sections: {}, added: [], context: {}, attachments: {}, tools: {}, ...rules }))
}

describe('what the model is sent', () => {
  test('section rules and the user\'s own sections shape the composed prompt', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { sections: { memory: { mode: 'drop' }, lean_body: { mode: 'replace', text: 'Mine.' } }, added: [{ id: 'custom-1', text: 'Check before you claim.' }] })
    await start($, clock)

    const composed = await $.prompt.compose(COMPOSE)

    expect(composed.sections).toEqual([
      { id: 'lean_body', text: 'Mine.', scope: 'shared' },
      { id: 'prompt-tweaker:custom-1', text: 'Check before you claim.', scope: 'session' },
    ])
  })

  test('an injected message type can be dropped or replaced, and others pass untouched', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { attachments: { output_style: { mode: 'drop' }, silent_turn_reminder: { mode: 'replace', text: 'Short note.' } } })
    await start($, clock)

    const origin = { kind: 'engine' } as const
    expect((await $.prompt.attachment({ type: 'output_style', text: 'Be concise.', origin })).text).toBeNull()
    expect((await $.prompt.attachment({ type: 'silent_turn_reminder', text: 'Say what you do.', origin })).text).toBe('Short note.')
    expect((await $.prompt.attachment({ type: 'date', text: 'Today is Monday.', origin })).text).toBe('Today is Monday.')
  })

  test('a context block is rewritten and a tool description replaced, but a tool is never emptied', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { context: { userEmail: { mode: 'drop' } }, tools: { Bash: { mode: 'replace', text: 'Runs a shell command.' }, Read: { mode: 'replace', text: '  ' } } })
    await start($, clock)

    const context = await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Rules' }, { name: 'userEmail', text: 'a@b.c' }] })
    expect(context.blocks).toEqual([{ name: 'claudeMd', text: 'Rules' }])
    const provider = { plugin: 'engine', tier: 'core' } as const
    expect((await $.tool.describe({ tool: 'Bash', description: 'Executes a bash command.', provider })).description).toBe('Runs a shell command.')
    expect((await $.tool.describe({ tool: 'Read', description: 'Reads a file.', provider })).description).toBe('Reads a file.')
  })

  test('pausing sends everything as made without losing the rules', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { isPaused: true, sections: { memory: { mode: 'drop' } } })
    await start($, clock)

    expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)
  })

  test('a rules file another session wrote is picked up', async ($, on) => {
    const { files, clock } = fakeHost(on)
    await start($, clock)
    expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)

    writeRules(files, { sections: { memory: { mode: 'drop' } } })
    // The mod trusts the rules it read for a few seconds before it checks the file again.
    expect((await $.prompt.compose(COMPOSE)).sections).toEqual(SECTIONS)
    await clock.advance(2100)

    expect((await $.prompt.compose(COMPOSE)).sections).toEqual([SECTIONS[0]])
  })

  test('Claude Code is asked for the session\'s tools again whenever the removed ones change, also from another session', async ($, on) => {
    const { files, clock, panes } = fakeHost(on)
    writeRules(files, { tools: { Bash: { mode: 'drop' } } })
    await start($, clock)
    expect(panes.invalidated).toEqual([])

    // Paused, every tool is back.
    writeRules(files, { isPaused: true, tools: { Bash: { mode: 'drop' } } })
    await clock.advance(2100)
    await $.prompt.compose(COMPOSE)
    expect(panes.invalidated).toEqual(['tool.list'])

    // An edited description removes nothing.
    writeRules(files, { tools: { Bash: { mode: 'replace', text: 'Mine.' } } })
    await clock.advance(2100)
    await $.prompt.compose(COMPOSE)
    expect(panes.invalidated).toEqual(['tool.list'])
  })

  test('re-read instruction copies follow the instructions rule until they have one of their own', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { attachments: { instructions: { mode: 'drop' } } })
    await start($, clock)
    expect((await $.prompt.attachment({ type: 'instructions', text: START_INSTRUCTIONS, origin: ENGINE })).text).toBeNull()
    expect((await $.prompt.attachment({ type: 'instructions', text: REREAD_COPY, origin: ENGINE })).text).toBeNull()

    writeRules(files, { attachments: { instructions: { mode: 'drop' }, [REREAD_INSTRUCTIONS]: { mode: 'replace', text: 'Changed: {{original}}' } } })
    await clock.advance(2100)
    expect((await $.prompt.attachment({ type: 'instructions', text: START_INSTRUCTIONS, origin: ENGINE })).text).toBeNull()
    expect((await $.prompt.attachment({ type: 'instructions', text: REREAD_COPY, origin: ENGINE })).text).toBe(`Changed: ${REREAD_COPY}`)

    writeRules(files, { attachments: { [REREAD_INSTRUCTIONS]: { mode: 'drop' } } })
    await clock.advance(2100)
    expect((await $.prompt.attachment({ type: 'instructions', text: START_INSTRUCTIONS, origin: ENGINE })).text).toBe(START_INSTRUCTIONS)
    expect((await $.prompt.attachment({ type: 'instructions', text: REREAD_COPY, origin: ENGINE })).text).toBeNull()
  })
})

describe('changing text', () => {
  test('find and replace changes a section whose text differs per project, keeping the rest current', async ($, on) => {
    const { files, clock, engine } = fakeHost(on)
    writeRules(files, { sections: { memory: { mode: 'patch', patches: [{ find: 'Memory at', replace: 'Notes at' }] } } })
    await start($, clock)

    engine.memory = 'Memory at /project-a.'
    expect((await $.prompt.compose(COMPOSE)).sections[1]?.text).toBe('Notes at /project-a.')
    engine.memory = 'Memory at /project-b.'
    expect((await $.prompt.compose(COMPOSE)).sections[1]?.text).toBe('Notes at /project-b.')
  })

  test('a full replacement with {{original}} wraps the current text', async ($, on) => {
    const { files, clock, engine } = fakeHost(on)
    writeRules(files, { sections: { memory: { mode: 'replace', text: '{{original}}\nCheck before you claim.' } } })
    await start($, clock)

    engine.memory = 'Memory at /project-c.'
    expect((await $.prompt.compose(COMPOSE)).sections[1]?.text).toBe('Memory at /project-c.\nCheck before you claim.')
  })

  test('a tool description takes find and replace, but never ends up empty', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { tools: { Bash: { mode: 'patch', patches: [{ find: 'bash', replace: 'shell' }] }, Read: { mode: 'patch', patches: [{ find: 'Reads a file.', replace: '' }] } } })
    await start($, clock)
    const provider = { plugin: 'engine', tier: 'core' } as const

    expect((await $.tool.describe({ tool: 'Bash', description: 'Runs a bash command.', provider })).description).toBe('Runs a shell command.')
    expect((await $.tool.describe({ tool: 'Read', description: 'Reads a file.', provider })).description).toBe('Reads a file.')
  })
})

describe('history', () => {
  test('counts each injected message once, as it is added, however often Claude Code asks about it', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { attachments: { output_style: { mode: 'drop' } } })
    await start($, clock)
    await inject($, 'output_style', 'Be concise.')
    await inject($, 'output_style', 'Be concise.')
    await inject($, 'date', 'Today.')
    // A resume or a reload asks about every stored message again, which adds nothing to the conversation.
    for (let round = 0; round < 3; round++) {
      await $.prompt.attachment({ type: 'output_style', text: 'Be concise.', origin: ENGINE })
      await $.prompt.attachment({ type: 'date', text: 'Today.', origin: ENGINE })
    }
    // Rows no request carries never reach the model, nor do other rows of the conversation.
    await $.session.append({ message: { type: 'attachment', name: 'credential_org', content: [] }, door: 'attachment', origin: ENGINE, uuid: 'no-request' })
    await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'Hello' }] }, door: 'prompt', origin: ENGINE, uuid: 'prompt' })
    await clock.advance(2000)

    const history = readHistory(files)
    expect(history.items.map(item => [item.name, item.action, item.count])).toEqual([['output_style', 'dropped', 2], ['date', 'sent', 1]])
    // The history keeps each text as the model reads it, without the transcript's reminder wrapper.
    const texts = [...files.files.keys()].filter(path => path.startsWith(`${ROOT}/texts/`)).map(path => files.read(path)).sort()
    expect(texts).toEqual(['Be concise.', 'Today.'])
    expect(JSON.parse(files.read(`${ROOT}/history/session-1.json`)).cwd).toBe('/work/project')
  })

  test('keeps re-read instruction copies apart from the instructions a conversation starts with', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { attachments: { [REREAD_INSTRUCTIONS]: { mode: 'drop' } } })
    await start($, clock)
    await inject($, 'instructions', START_INSTRUCTIONS)
    await inject($, 'instructions', REREAD_COPY)
    await clock.advance(2000)

    expect(readHistory(files).items.map(item => [item.name, item.action, item.count])).toEqual([['instructions', 'sent', 1], [REREAD_INSTRUCTIONS, 'dropped', 1]])
  })

  test('counts nothing for prompt sections and context blocks, and leaves a first-release history\'s counts unknown', async ($, on) => {
    const { files, clock } = fakeHost(on)
    const seen = { kind: 'attachment', name: 'date', length: 6, action: 'sent', firstAt: 1, lastAt: 2 }
    files.write(`${ROOT}/history/session-1.json`, JSON.stringify({ version: 1, sessionId: 'session-1', cwd: '/work/project', startedAt: 1, lastAt: 2, items: [{ ...seen, hash: await sha256('Today.'), count: 5 }] }))
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    await $.prompt.compose(COMPOSE)
    await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'Today.' }] })
    await inject($, 'date', 'Today.')
    await inject($, 'date', 'Tomorrow.')
    await clock.advance(2000)

    const history = readHistory(files)
    expect(history.version).toBe(2)
    expect(history.items.map(item => [item.kind, item.name, item.count])).toEqual([
      ['attachment', 'date', 0],
      ['section', 'lean_body', 0],
      ['section', 'memory', 0],
      ['context', 'currentDate', 0],
      ['attachment', 'date', 1],
    ])
  })
})

/** The band above the prompt as the engine raises it: no survey, idle, room for a few rows. */
const BAND = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} } as const

/** Another mod's row above the prompt, and this mod's own, as their AbovePrompt hooks drew them. */
const OTHER_ROW = { plugin: 'commit-push', tree: { type: 'Text', children: ['commit row'] } as RenderElement }
const OWN_ROW = { plugin: 'prompt-tweaker', tree: { type: 'Text', children: ['own row'] } as RenderElement }

describe('the button above the prompt', () => {
  test('the button above the prompt opens it, at the right end of its line', async ($, on) => {
    const { clock, panes } = fakeHost(on)
    await start($, clock)
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'AbovePrompt', props: BAND })
      expect(await band.drawn()).toMatchObject({ type: 'Box', props: { justifyContent: 'flex-end' } })
      await band.press({ key: 'open-tweaker' })
      await band.unmount()
    }
    expect(panes.opened).toEqual(SURFACES.map(() => ({ id: 'prompt-tweaker', title: 'Claude Tweaker' })))
    await $.command.run({ command: 'tweaker', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(panes.opened.length).toBe(SURFACES.length + 1)
  })

  test('with other mods\' rows above the prompt, the button ends their line instead of taking one of its own', async ($, on) => {
    const { clock, panes } = fakeHost(on)
    await start($, clock)
    for (const surface of SURFACES) {
      const band = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'AbovePromptList', props: { ...BAND, rows: [OWN_ROW, OTHER_ROW] } })
      const line = await band.drawn()
      expect(line).toMatchObject({ type: 'Box', props: { justifyContent: 'space-between' } })
      expect(line.type === 'Box' ? (line.children ?? []).at(-1) : undefined).toMatchObject({ type: 'Button', props: { key: 'open-tweaker' } })
      expect(await band.find({ type: 'Text', text: /commit row/ })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /own row/ })).toBeUndefined()
      await band.press({ key: 'open-tweaker' })
      await band.unmount()
    }
    expect(panes.opened.length).toBe(SURFACES.length)

    const alone = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'AbovePromptList', props: { ...BAND, rows: [OWN_ROW] } })
    expect(await alone.find({ type: 'Text', text: /own row/ })).toBeDefined()
    await alone.unmount()
    const survey = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
    expect(await survey.find({ key: 'open-tweaker' })).toBeUndefined()
    await survey.unmount()
  })
})

describe('panel', () => {
  test('lists the composed sections and saves an edit from the editor', async ($, on) => {
    const { files, clock } = fakeHost(on)
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
      expect(await ui.find({ key: 'section-memory' })).toBeDefined()

      await ui.press({ key: 'section-memory' })
      await ui.input({ key: 'editor-section:memory', text: 'My memory rules.\nSecond line.', kind: 'change' })
      await ui.press({ key: 'save' })

      expect(JSON.parse(files.read(`${ROOT}/rules.json`)).sections.memory).toEqual({ mode: 'replace', text: 'My memory rules.\nSecond line.' })
      await ui.press({ key: 'back' })
      expect((await ui.find({ type: 'Text', text: 'edited' }))?.props.color).toBe('warning')
      await ui.press({ key: 'section-memory' })
      expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.text)).toEqual(['You are an agent.', 'My memory rules.\nSecond line.'])
      expect(await ui.find({ key: 'reset' })).toBeDefined()
      await ui.press({ key: 'reset' })
      expect(JSON.parse(files.read(`${ROOT}/rules.json`)).sections).toEqual({})
      await ui.press({ key: 'back' })
      await ui.unmount()
    }
  })

  test('drops an injected message type from its detail view', async ($, on) => {
    const { files, clock } = fakeHost(on)
    await start($, clock)
    await $.prompt.attachment({ type: 'output_style', text: 'Be concise.', origin: { kind: 'engine' } })
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'tab-injected' })
    await ui.press({ key: 'attachment-output_style' })
    await ui.press({ key: 'drop' })

    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).attachments.output_style).toEqual({ mode: 'drop' })
    expect(await ui.find({ key: 'drop' })).toBeUndefined()
    await ui.press({ key: 'back' })
    // The status sits beside the row's button, where the desktop app keeps its color.
    expect((await ui.find({ type: 'Text', text: 'dropped' }))?.props.color).toBe('error')
    expect((await ui.find({ key: 'attachment-output_style' }))?.props.label).toBe('output_style')
    expect((await $.prompt.attachment({ type: 'output_style', text: 'Be concise.', origin: { kind: 'engine' } })).text).toBeNull()
    await ui.unmount()
  })

  test('lists re-read instruction copies apart, following the instructions edit until they get their own', async ($, on) => {
    const { files, clock } = fakeHost(on)
    await start($, clock)
    await $.prompt.attachment({ type: 'instructions', text: START_INSTRUCTIONS, origin: ENGINE })
    await $.prompt.attachment({ type: 'instructions', text: REREAD_COPY, origin: ENGINE })
    const rereadRow = `attachment-${REREAD_INSTRUCTIONS}`
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
      await ui.press({ key: 'tab-injected' })
      await ui.press({ key: 'attachment-instructions' })
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe(START_INSTRUCTIONS)
      await ui.press({ key: 'drop' })
      await ui.press({ key: 'back' })

      // Dropped along with instructions: there is nothing to drop or reset of its own.
      await ui.press({ key: rereadRow })
      expect((await ui.find({ type: 'Code' }))?.props.source).toBe(REREAD_COPY)
      expect(await ui.find({ key: 'drop' })).toBeUndefined()
      expect(await ui.find({ key: 'reset' })).toBeUndefined()

      await ui.input({ key: `editor-attachment:${REREAD_INSTRUCTIONS}`, text: 'Changed: {{original}}', kind: 'change' })
      await ui.press({ key: 'save' })
      expect(JSON.parse(files.read(`${ROOT}/rules.json`)).attachments).toEqual({ instructions: { mode: 'drop' }, [REREAD_INSTRUCTIONS]: { mode: 'replace', text: 'Changed: {{original}}' } })
      expect(await ui.find({ key: 'drop' })).toBeDefined()
      expect((await $.prompt.attachment({ type: 'instructions', text: REREAD_COPY, origin: ENGINE })).text).toBe(`Changed: ${REREAD_COPY}`)

      await ui.press({ key: 'reset' })
      expect(await ui.find({ key: 'drop' })).toBeUndefined()
      expect((await $.prompt.attachment({ type: 'instructions', text: REREAD_COPY, origin: ENGINE })).text).toBeNull()
      await ui.press({ key: 'back' })
      await ui.press({ key: 'attachment-instructions' })
      await ui.press({ key: 'reset' })
      expect(JSON.parse(files.read(`${ROOT}/rules.json`)).attachments).toEqual({})
      await ui.unmount()
    }
  })

  test('sorts the lists by name or by size, one choice for every tab that later sessions open with', async ($, on) => {
    const { clock, engine, store } = fakeHost(on)
    await start($, clock)
    engine.extra = [{ id: 'aaa_short', text: 'Hi.', scope: 'session' }, { id: 'zzz_long', text: 'A much longer section than the others are.', scope: 'session' }]
    await $.prompt.compose(COMPOSE)
    await $.prompt.attachment({ type: 'date', text: 'Today.', origin: ENGINE })
    await $.prompt.attachment({ type: 'output_style', text: 'Be concise and clear.', origin: ENGINE })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
      const order = async (prefix: string): Promise<(string | undefined)[]> => (await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith(prefix))
      await ui.press({ key: 'tab-prompt' })
      expect(await order('section-')).toEqual(['section-lean_body', 'section-memory', 'section-aaa_short', 'section-zzz_long'])

      await ui.select({ key: 'sort', value: 'name' })
      expect(await order('section-')).toEqual(['section-aaa_short', 'section-lean_body', 'section-memory', 'section-zzz_long'])
      await ui.select({ key: 'sort', value: 'size' })
      expect(await order('section-')).toEqual(['section-zzz_long', 'section-lean_body', 'section-memory', 'section-aaa_short'])
      expect(store.get('listSort')).toBe('size')

      await ui.press({ key: 'tab-injected' })
      expect((await ui.find({ key: 'sort' }))?.props.value).toBe('size')
      expect(await order('attachment-')).toEqual(['attachment-output_style', 'attachment-date'])
      // A list ordered by name of its own offers no other own order, and shows it as by name.
      await ui.select({ key: 'sort', value: 'name' })
      expect(await order('attachment-')).toEqual(['attachment-date', 'attachment-output_style'])
      await ui.press({ key: 'tab-prompt' })
      await ui.select({ key: 'sort', value: 'natural' })
      await ui.press({ key: 'tab-injected' })
      expect((await ui.find({ key: 'sort' }))?.props.value).toBe('name')
      expect(((await ui.find({ key: 'sort' }))?.props.options as { value: string }[]).map(option => option.value)).toEqual(['name', 'size'])
      await ui.unmount()
    }
  })

  test('opens with the order an earlier session picked, and sorts a session\'s history the same way', async ($, on) => {
    const { clock, engine } = fakeHost(on, { listSort: 'size' })
    engine.memory = 'Memory rules that are long enough to lead.'
    await start($, clock)
    await inject($, 'date', 'Today.')
    await clock.advance(1000)
    await inject($, 'output_style', 'Be concise and clear.')
    await $.prompt.compose(COMPOSE)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
    const order = async (prefix: string): Promise<(string | undefined)[]> => (await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith(prefix))

    expect(await order('section-')).toEqual(['section-memory', 'section-lean_body'])
    await ui.press({ key: 'tab-history' })
    await ui.press({ key: 'refresh-history' })
    await ui.press({ key: 'session-session-1' })
    // Items keep their index in the history as their key, whatever order they are shown in.
    const items = (await ui.findAll({ type: 'Button' })).filter(found => found.key?.startsWith('item-')).map(found => found.props.label)
    expect(items.map(label => String(label).split(' ').pop())).toEqual(['memory', 'output_style', 'lean_body', 'date'])
    await ui.select({ key: 'sort', value: 'natural' })
    const byTime = (await ui.findAll({ type: 'Button' })).filter(found => found.key?.startsWith('item-')).map(found => String(found.props.label).split(' ').pop())
    expect(byTime).toEqual(['date', 'output_style', 'lean_body', 'memory'])
    await ui.unmount()
  })

  test('removes a tool from its detail view and brings it back', async ($, on) => {
    const { files, clock, panes } = fakeHost(on)
    await start($, clock)
    await $.tool.describe({ tool: 'Bash', description: 'Runs a shell command.', provider: { plugin: 'engine', tier: 'core' } })
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'tab-tools' })
    await ui.press({ key: 'tool-Bash' })
    await ui.press({ key: 'drop' })
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).tools).toEqual({ Bash: { mode: 'drop' } })
    expect(await ui.find({ key: 'drop' })).toBeUndefined()
    expect(panes.invalidated).toEqual(['tool.list'])
    // The tool's description is never emptied for it: the tool leaves the list instead.
    expect((await $.tool.describe({ tool: 'Bash', description: 'Runs a shell command.', provider: { plugin: 'engine', tier: 'core' } })).description).toBe('Runs a shell command.')

    await ui.press({ key: 'reset' })
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).tools).toEqual({})
    expect(panes.invalidated).toEqual(['tool.list', 'tool.list'])
    await ui.unmount()
  })

  test('a tab value stored under no shape tag opens the System Prompt tab', async ($, on) => {
    const { clock } = fakeHost(on)
    // The session keeps $.state through a reload of the mod, so a tab name no TABS entry has can come back untagged.
    on('state.get', ($, e, next) => (e.plugin === 'prompt-tweaker' && e.key === 'tab' ? { value: { value: 'api', version: 1 } } : next(e)))
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
      expect((await ui.find({ key: 'tab-prompt' }))?.props.variant).toBe('primary')
      expect(await ui.find({ key: 'section-lean_body' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the prompt mode buttons write and remove only their own setting', async ($, on) => {
    const { files, clock } = fakeHost(on)
    files.write(SETTINGS, JSON.stringify({ outputStyle: 'Concise', env: { OTHER: 'x' } }))
    await start($, clock)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
    expect((await ui.find({ key: 'mode-default' }))?.props.variant).toBe('primary')

    await ui.press({ key: 'mode-short' })
    expect(JSON.parse(files.read(SETTINGS))).toEqual({ outputStyle: 'Concise', env: { OTHER: 'x', CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1' } })
    expect((await ui.find({ key: 'mode-short' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'mode-full' })
    expect(JSON.parse(files.read(SETTINGS))).toEqual({ outputStyle: 'Concise', env: { OTHER: 'x', CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '0' } })
    await ui.press({ key: 'mode-default' })
    expect(JSON.parse(files.read(SETTINGS))).toEqual({ outputStyle: 'Concise', env: { OTHER: 'x' } })
    await ui.unmount()
  })

  test('keeps the short and the full prompt apart, each with its own originals', async ($, on) => {
    const { files, clock } = fakeHost(on)
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    await clock.advance(10)
    await $.prompt.compose(COMPOSE_FULL)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    // The latest composed version is listed first.
    expect((await ui.find({ key: 'view-full' }))?.props.variant).toBe('primary')
    expect(await ui.find({ key: 'section-doing_tasks' })).toBeDefined()
    expect(await ui.find({ key: 'section-lean_body' })).toBeUndefined()

    await ui.press({ key: 'view-lean' })
    expect(await ui.find({ key: 'section-lean_body' })).toBeDefined()
    await ui.press({ key: 'section-memory' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('Memory rules.')
    await ui.press({ key: 'drop' })
    await ui.unmount()

    // An edit is kept by section name, so a section both versions have is dropped from both.
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).sections).toEqual({ memory: { mode: 'drop' } })
    expect((await $.prompt.compose(COMPOSE_FULL)).sections.map(section => section.id)).toEqual(['intro', 'doing_tasks'])
  })

  test('the editor switches between full replacement and find & replace, and saves what it shows', async ($, on) => {
    const { files, clock, engine } = fakeHost(on)
    await start($, clock)
    engine.memory = 'Memory at /project-a. Keep notes.'
    await $.prompt.compose(COMPOSE)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface, component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
      await ui.press({ key: 'section-memory' })
      expect((await ui.find({ key: 'edit-full' }))?.props.variant).toBe('primary')
      await ui.input({ key: 'editor-section:memory', text: 'Draft kept while switching', kind: 'change' })

      await ui.press({ key: 'edit-patch' })
      await ui.input({ key: 'find-0', text: 'Keep notes.', kind: 'change' })
      await ui.input({ key: 'replace-0', text: 'Keep short notes.', kind: 'change' })
      expect(await ui.find({ type: 'Text', text: 'Found once' })).toBeDefined()
      const preview = (await ui.findAll({ type: 'Code' })).map(code => code.props.source)
      expect(preview).toContain('Memory at /project-a. Keep short notes.')

      await ui.press({ key: 'add-patch' })
      await ui.input({ key: 'find-1', text: 'not in the text', kind: 'change' })
      expect((await ui.find({ type: 'Text', text: "Not found in Claude Code's current text" }))?.props.color).toBe('error')
      await ui.press({ key: 'remove-patch-1' })

      await ui.press({ key: 'edit-full' })
      expect((await ui.find({ key: 'editor-section:memory' }))?.props.value).toBe('Draft kept while switching')
      await ui.press({ key: 'edit-patch' })
      await ui.press({ key: 'save' })

      expect(JSON.parse(files.read(`${ROOT}/rules.json`)).sections.memory).toEqual({ mode: 'patch', patches: [{ find: 'Keep notes.', replace: 'Keep short notes.' }] })
      expect((await ui.find({ key: 'edit-patch' }))?.props.variant).toBe('primary')
      await ui.press({ key: 'reset' })
      await ui.press({ key: 'back' })
      await ui.unmount()
    }
  })

  test('marks a section whose text changed between sightings', async ($, on) => {
    const { clock, engine } = fakeHost(on)
    await start($, clock)
    engine.memory = 'Memory at /project-a.'
    await $.prompt.compose(COMPOSE)
    engine.memory = 'Memory at /project-b.'
    await $.prompt.compose(COMPOSE)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'tab-prompt' })
    expect((await ui.find({ type: 'Text', text: 'changes per session' }))?.props.color).toBe('suggestion')
    expect((await ui.findAll({ type: 'Text', text: 'changes per session' })).length).toBe(1)
    await ui.press({ key: 'section-memory' })
    expect(await ui.find({ type: 'Text', text: /changes between sessions/ })).toBeDefined()
    await ui.unmount()
  })

  test('remembers a section the latest prompt lacks, so it can be dropped before it comes back', async ($, on) => {
    const { files, clock, engine } = fakeHost(on)
    await start($, clock)
    engine.extra = [{ id: 'fable_identity', text: 'You are Fable.', scope: 'session' }]
    await $.prompt.compose(COMPOSE)
    engine.extra = []
    await clock.advance(10)
    await $.prompt.compose(COMPOSE)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    // Listed after the latest prompt's sections, in a group of its own.
    expect((await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith('section-'))).toEqual(['section-lean_body', 'section-memory', 'section-fable_identity'])
    await ui.press({ key: 'section-fable_identity' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('You are Fable.')
    await ui.press({ key: 'drop' })
    await ui.unmount()

    engine.extra = [{ id: 'fable_identity', text: 'You are Fable.', scope: 'session' }]
    expect((await $.prompt.compose(COMPOSE)).sections.map(section => section.id)).toEqual(['lean_body', 'memory'])
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).sections).toEqual({ fable_identity: { mode: 'drop' } })
  })

  test('remembers a context block the latest conversation lacks', async ($, on) => {
    const { clock } = fakeHost(on)
    await start($, clock)
    await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Rules' }, { name: 'attachedProject', text: 'Project notes' }] })
    await clock.advance(10)
    await $.prompt.context({ blocks: [{ name: 'claudeMd', text: 'Rules' }] })
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'tab-context' })
    expect((await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith('context-'))).toEqual(['context-claudeMd', 'context-attachedProject'])
    await ui.unmount()
  })

  test('recovers sections and context blocks from earlier sessions\' histories', async ($, on) => {
    const { files, clock } = fakeHost(on)
    const item = { length: 10, action: 'sent', firstAt: 5, lastAt: 6, count: 1 }
    files.write(`${ROOT}/history/old-session.json`, JSON.stringify({ version: 1, sessionId: 'old-session', cwd: '/old', startedAt: 5, lastAt: 6, items: [
      { ...item, kind: 'section', name: 'bg-session', hash: 'ab01', variant: 'lean' },
      { ...item, kind: 'context', name: 'attachedProject', hash: 'ab02' },
    ] }))
    files.write(`${ROOT}/texts/ab/ab01.txt`, 'Background job rules.')
    files.write(`${ROOT}/texts/ab/ab02.txt`, 'Project notes.')
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'tab-history' })
    await ui.press({ key: 'tab-prompt' })
    await ui.press({ key: 'section-bg-session' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('Background job rules.')
    await ui.press({ key: 'tab-context' })
    expect(await ui.find({ key: 'context-attachedProject' })).toBeDefined()
    await ui.unmount()
  })

  test('lists the sections of a first-release history, which kept no prompt version, in the version they were sent in', async ($, on) => {
    const { files, clock } = fakeHost(on)
    const item = { kind: 'section', length: 10, action: 'sent', firstAt: 5, lastAt: 6, count: 3 }
    files.write(`${ROOT}/history/fable-session.json`, JSON.stringify({ version: 1, sessionId: 'fable-session', cwd: '/old', startedAt: 5, lastAt: 6, items: [
      { ...item, name: 'lean_body', hash: 'ab01' },
      { ...item, name: 'fable_identity', hash: 'ab02' },
    ] }))
    files.write(`${ROOT}/texts/ab/ab01.txt`, 'You are an agent.')
    files.write(`${ROOT}/texts/ab/ab02.txt`, 'You are Fable.')
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    await $.command.run({ command: 'tweaker', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    expect((await ui.findAll({ type: 'Button' })).map(found => found.key).filter(key => key?.startsWith('section-'))).toEqual(['section-lean_body', 'section-memory', 'section-fable_identity'])
    await ui.press({ key: 'section-fable_identity' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('You are Fable.')
    await ui.unmount()
  })

  test('reads a catalog of the first release as the version it held', async ($, on) => {
    const { files, clock } = fakeHost(on)
    files.write(`${ROOT}/catalog.json`, JSON.stringify({ version: 1, sections: { lean_body: { text: 'Old body.', lastAt: 3 } }, sectionOrder: ['lean_body'], context: {}, contextOrder: [], attachments: {}, tools: {}, promptVariant: 'lean', model: 'claude-opus-5-5' }))
    await start($, clock)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'section-lean_body' })
    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('Old body.')
    await ui.unmount()
  })

  test('leaves a settings file it cannot read untouched', async ($, on) => {
    const { files, clock } = fakeHost(on)
    files.write(SETTINGS, '{ not json')
    await start($, clock)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    expect(await ui.find({ key: 'mode-full' })).toBeUndefined()
    expect(files.read(SETTINGS)).toBe('{ not json')
    await ui.unmount()
  })

  test('edits, drops and resets an item from a session\'s history, as its own tab does', async ($, on) => {
    const { files, clock } = fakeHost(on)
    await start($, clock)
    await inject($, 'date', 'Today is Monday.')
    await $.prompt.compose(COMPOSE)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
    const sources = async (): Promise<unknown[]> => (await ui.findAll({ type: 'Code' })).map(code => code.props.source)
    await ui.press({ key: 'tab-history' })
    await ui.press({ key: 'refresh-history' })
    await ui.press({ key: 'session-session-1' })

    // Claude Code's latest text of the type is not known yet, so the session's own text shows.
    await ui.press({ key: 'item-0' })
    expect(await sources()).toEqual(['Today is Monday.'])
    await ui.press({ key: 'drop' })
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).attachments).toEqual({ date: { mode: 'drop' } })
    expect((await $.prompt.attachment({ type: 'date', text: 'Today is Monday.', origin: ENGINE })).text).toBeNull()
    await ui.press({ key: 'reset' })
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).attachments).toEqual({})

    // Once Claude Code's latest text is the session's, it shows once, as the editor's.
    await ui.press({ key: 'items' })
    await ui.press({ key: 'item-0' })
    expect(await sources()).toEqual(['Today is Monday.'])
    await ui.press({ key: 'edit-patch' })
    await ui.input({ key: 'find-0', text: 'Monday', kind: 'change' })
    await ui.input({ key: 'replace-0', text: 'Tuesday', kind: 'change' })
    await ui.press({ key: 'save' })
    expect((await $.prompt.attachment({ type: 'date', text: 'Today is Monday.', origin: ENGINE })).text).toBe('Today is Tuesday.')

    // A section opens in the prompt version it was sent in.
    await ui.press({ key: 'items' })
    await ui.press({ key: 'item-1' })
    await ui.input({ key: 'editor-section:lean_body', text: 'Mine.', kind: 'change' })
    await ui.press({ key: 'save' })
    expect(JSON.parse(files.read(`${ROOT}/rules.json`)).sections).toEqual({ lean_body: { mode: 'replace', text: 'Mine.' } })
    await ui.unmount()
  })

  test('a section of the user\'s own deleted since shows its history without an editor', async ($, on) => {
    const { files, clock } = fakeHost(on)
    writeRules(files, { added: [{ id: 'custom-1', text: 'Check before you claim.' }] })
    await start($, clock)
    await $.prompt.compose(COMPOSE)
    writeRules(files, { added: [] })
    await clock.advance(2100)
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })
    await ui.press({ key: 'tab-history' })
    await ui.press({ key: 'refresh-history' })
    await ui.press({ key: 'session-session-1' })
    const added = (await ui.findAll({ type: 'Button' })).find(found => String(found.props.label).endsWith('prompt-tweaker:custom-1'))
    await ui.press({ key: String(added?.key) })

    expect(await ui.find({ key: 'save' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Code' })).map(code => code.props.source)).toEqual(['Check before you claim.'])
    await ui.unmount()
  })

  test('shows a session\'s history and an item\'s full text', async ($, on) => {
    const { clock } = fakeHost(on)
    await start($, clock)
    await inject($, 'date', 'Today is Monday.')
    const ui = await $.ui.mount({ plugin: 'prompt-tweaker', surface: 'desktop', component: 'Pane', requestId: 'prompt-tweaker', props: PANE_PROPS })

    await ui.press({ key: 'tab-history' })
    await ui.press({ key: 'refresh-history' })
    await ui.press({ key: 'session-session-1' })
    await ui.press({ key: 'item-0' })

    expect((await ui.find({ type: 'Code' }))?.props.source).toBe('Today is Monday.')
    await ui.unmount()
  })
})

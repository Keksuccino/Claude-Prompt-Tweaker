import type { Elements, RenderElement } from 'claude-code'

import type { Action, Draft, HistoryItem, Kind, ListSort, PromptMode, PromptVariant, Rule, Tab, Target } from '../types'
import { renderApiTab } from './apiTab'
import type { TweakerController } from './controller'
import { draftKey } from './controller'
import { INSTRUCTIONS, REREAD_INSTRUCTIONS } from './injected'
import type { Io, PaneState } from './io'
import { ADDED_PREFIX, applyPatches, countMatches, fillOriginal, inheritedRule, ORIGINAL_TOKEN, ruleMap } from './rules'
import type { Detail, Ui } from './ui'
import { formatClock, formatCount, formatTime, listRow } from './ui'


/** The elements the button above the prompt draws with. */
export type BandUi = Pick<Elements['desktop'], 'Box' | 'Button'>

/** The panel's name: its title and the label of the button above the prompt. */
export const PANEL_TITLE = 'Claude Tweaker'

type View = { io: Io; ui: Ui; control: TweakerController; state: PaneState }

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'prompt', label: 'System Prompt', hotkey: '1' },
  { id: 'context', label: 'Context', hotkey: '2' },
  { id: 'injected', label: 'Injected', hotkey: '3' },
  { id: 'tools', label: 'Tools', hotkey: '4' },
  { id: 'desktop', label: 'Desktop App', hotkey: '5' },
  { id: 'history', label: 'History', hotkey: '6' },
  { id: 'api', label: 'API Traffic', hotkey: '7' },
]

const KIND_LABEL: Record<Kind | 'added', string> = {
  section: 'System Prompt Section',
  added: 'Your Own Section',
  context: 'First-Message Context',
  attachment: 'Injected Message Type',
  tool: 'Tool Description',
}

const MODES: { id: PromptMode; label: string }[] = [
  { id: 'default', label: 'Model Default' },
  { id: 'full', label: 'Always Full' },
  { id: 'short', label: 'Always Short' },
]

const MODE_HINT: Record<PromptMode, string> = {
  default: 'Claude Code picks the full or the short prompt per model.',
  full: 'Every model gets the full prompt.',
  short: 'Every model gets the short prompt.',
}

const VARIANT_ORDER: readonly PromptVariant[] = ['lean', 'full', 'bare']

const VARIANT_LABEL: Record<PromptVariant, string> = { lean: 'Short Prompt', full: 'Full Prompt', bare: 'Bare Prompt' }

/** Long texts scroll inside the editor; this many rows show without the panel jumping as the text grows. */
const EDITOR_ROWS = 14

/** A find or replace field: room for a sentence or two, longer text scrolls inside it. */
const PATCH_ROWS = 3

/** How the two kinds of instruction file messages relate, said on each one's detail view. */
const RELATION_HINT: Record<string, string> = {
  [INSTRUCTIONS]: 'Your instruction files, sent when a conversation starts and after a compaction. When they change mid-conversation, like before a resume, Claude Code sends the changed files again: those re-read copies are listed apart and follow your edit here unless you give them their own.',
  [REREAD_INSTRUCTIONS]: 'Sent when your instruction files changed since the conversation got them, like before a resume: only the changed files, each replacing its earlier copy. Dropping these keeps the model on the earlier copies. Without an edit of their own they follow your edit of instructions.',
}

export function renderPane(ui: Ui, state: PaneState, io: Io, control: TweakerController): RenderElement {
  const view: View = { io, ui, control, state }
  const { Box } = ui
  const isDetail = state.selected !== null && state.tab !== 'history' && state.tab !== 'desktop' && state.tab !== 'api'

  return (
    <Box flexDirection="column" gap={1}>
      {tabBar(view)}
      {pauseLine(view)}
      {noticeLine(view)}
      {isDetail && state.selected !== null ? detail(view, state.selected) : tabBody(view)}
    </Box>
  )
}

/** The mod's own row above the prompt, while no other mod has one: the button at the right end of the line. */
export function renderBandRow(ui: BandUi, onOpen: () => void): RenderElement {
  const { Box } = ui

  return (
    <Box width="100%" justifyContent="flex-end">
      {bandButton(ui, onOpen)}
    </Box>
  )
}

/**
 * Other mods' rows above the prompt and the button in one line, the button pushed to its right end. The engine refuses a
 * fixed width on a Box around other mods' rows, so the line grows to fill instead: the band's column stretches it, and in
 * another mod's line it takes the room that mod's buttons leave. `flex-start` keeps the button one line tall and level with
 * the first row while another mod's row is taller.
 */
export function renderBandLine(ui: BandUi, others: RenderElement, onOpen: () => void): RenderElement {
  const { Box } = ui

  return (
    <Box flexGrow={1} justifyContent="space-between" alignItems="flex-start" columnGap={1}>
      {others}
      {bandButton(ui, onOpen)}
    </Box>
  )
}

function bandButton({ Button }: BandUi, onOpen: () => void): RenderElement {
  return <Button key="open-tweaker" label={PANEL_TITLE} onPress={onOpen} />
}

function tabBar({ io, ui, control, state }: View): RenderElement {
  const { Box, Button } = ui

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {TABS.map(one => (
        <Button key={`tab-${one.id}`} label={one.label} hotkey={one.hotkey} variant={one.id === state.tab ? 'primary' : 'secondary'} onPress={() => void control.selectTab(io, one.id)} />
      ))}
    </Box>
  )
}

function pauseLine({ io, ui, control }: View): RenderElement {
  const { Box, Button, Text } = ui
  const isPaused = control.store.rules.isPaused
  const count = ruleCount(control)
  const text = isPaused ? 'All edits are paused: everything is sent as Claude Code made it.' : count === 0 ? 'No edits yet: everything is sent as Claude Code made it.' : `${count} ${count === 1 ? 'edit is' : 'edits are'} active.`

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center">
      <Text color={isPaused ? 'warning' : 'subtle'}>{text}</Text>
      {(isPaused || count > 0) && <Button key="pause" label={isPaused ? 'Resume Edits' : 'Pause All Edits'} plain dimColor onPress={() => void control.togglePause(io)} />}
    </Box>
  )
}

function noticeLine({ io, ui, control, state }: View): RenderElement | null {
  if (state.notice === null) {
    return null
  }
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={state.notice.isError ? 'error' : 'success'}>{state.notice.text}</Text>
      <Button key="dismiss-notice" label="Dismiss" plain dimColor onPress={() => void control.dismissNotice(io)} />
    </Box>
  )
}

function tabBody(view: View): RenderElement {
  const catalog = view.control.store.catalog
  switch (view.state.tab) {
    case 'prompt':
      return promptTab(view)
    case 'context':
      return contextTab(view)
    case 'injected':
      return itemList(view, 'attachment', sortItems(view, 'attachment', Object.keys(catalog.attachments), false), 'Messages Claude Code injects on its own while you work: reminders, mode changes, listings, files you mention. A rule applies to every message of that type.')
    case 'tools':
      return toolsTab(view)
    case 'desktop':
      return desktopTab(view)
    case 'history':
      return historyTab(view)
    case 'api':
      return renderApiTab(view)
  }
}

function promptTab(view: View): RenderElement {
  const { io, ui, control, state } = view
  const { Box, Button, Text } = ui
  const catalog = control.store.catalog
  const shown = state.promptView !== null && catalog.prompts[state.promptView] !== undefined ? state.promptView : catalog.lastVariant
  const snapshot = shown === null ? undefined : catalog.prompts[shown]
  const seen = VARIANT_ORDER.filter(variant => catalog.prompts[variant] !== undefined)
  const unseen = (['lean', 'full'] as const).filter(variant => catalog.prompts[variant] === undefined)
  const latest = snapshot === undefined ? [] : snapshot.order.filter(name => !name.startsWith(ADDED_PREFIX) && name in snapshot.sections)
  const remembered = snapshot === undefined ? [] : rememberedNames(snapshot.sections, latest)
  const variant = shown ?? undefined
  const added = sorted(control.store.rules.added, shownSort(state.listSort, true), one => one.id, one => one.text.length)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>System Prompt in New Sessions</Text>
        {state.promptMode === 'unknown' ? (
          <Text color="error">Couldn't read ~/.claude/settings.json, so this can't be changed here.</Text>
        ) : (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {MODES.map(mode => (
              <Button key={`mode-${mode.id}`} label={mode.label} variant={mode.id === state.promptMode ? 'primary' : 'secondary'} onPress={() => void control.setPromptMode(io, mode.id)} />
            ))}
          </Box>
        )}
        {state.promptMode !== 'unknown' && <Text dimColor>{`${MODE_HINT[state.promptMode]} A change applies to sessions you start from now on.`}</Text>}
      </Box>
      <Box flexDirection="column">
        <Text bold>Sections</Text>
        {seen.length > 1 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {seen.map(variant => (
              <Button key={`view-${variant}`} label={VARIANT_LABEL[variant]} variant={variant === shown ? 'primary' : 'secondary'} onPress={() => void control.setPromptView(io, variant)} />
            ))}
          </Box>
        )}
        <Text dimColor>
          {snapshot === undefined || shown === null
            ? 'No system prompt seen yet. It shows up here once a conversation starts.'
            : snapshot.order.length === 0
              ? `No recent session got the ${VARIANT_LABEL[shown].toLowerCase()}, so only its sections from earlier sessions are listed. Changes apply to new conversations.`
              : `The ${VARIANT_LABEL[shown].toLowerCase()} as last sent, to ${snapshot.model} on ${formatTime(snapshot.lastAt)}. Changes apply to new conversations.${unseen.length === 0 ? '' : ` The ${unseen.map(one => VARIANT_LABEL[one].toLowerCase()).join(' and the ')} shows up here once a session gets it.`}`}
        </Text>
      </Box>
      {latest.length + remembered.length + added.length > 1 && sortPicker(view, AS_SENT)}
      {latest.length > 0 && shown !== null && listRows(view, 'section', sortItems(view, 'section', latest, true, variant), shown)}
      {remembered.length > 0 && shown !== null && rememberedGroup(view, 'section', sortItems(view, 'section', remembered, true, variant), shown, 'Not in the Latest Prompt', 'Claude Code sends these only sometimes, depending on the model, the mode or a feature. Your edits apply whenever it sends them again.')}
      <Text bold>Your Own Sections</Text>
      {added.length === 0 && <Text dimColor>Sections you add are sent after Claude Code's own, in either prompt version.</Text>}
      {added.length > 0 && (
        <Box flexDirection="column">
          {added.map(one => (
            listRow(ui, { key: `added-${one.id}`, label: one.id, onPress: () => void control.open(io, { kind: 'added', name: one.id }), details: [{ text: one.text.trim() === '' ? 'empty, not sent' : `${formatCount(one.text.length)} characters`, tone: 'dim' }] })
          ))}
        </Box>
      )}
      <Box>
        <Button key="add-section" label="Add a Section" onPress={() => void control.addSection(io)} />
      </Box>
    </Box>
  )
}

function contextTab(view: View): RenderElement {
  const { Box, Text } = view.ui
  const context = view.control.store.catalog.context
  const latest = view.control.store.catalog.contextOrder.filter(name => name in context)
  const remembered = rememberedNames(context, latest)

  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>The context Claude Code adds to the first message of each conversation: your CLAUDE.md files, your email, the date. Editing changes what is sent, never the files themselves.</Text>
      {latest.length + remembered.length > 1 && sortPicker(view, AS_SENT)}
      {latest.length === 0 && remembered.length === 0 ? <Text dimColor>Nothing seen yet. Items show up here once Claude Code sends them.</Text> : listRows(view, 'context', sortItems(view, 'context', latest, true))}
      {remembered.length > 0 && rememberedGroup(view, 'context', sortItems(view, 'context', remembered, true), undefined, 'Not in the Latest Conversation', 'Claude Code adds these only sometimes. Your edits apply whenever it adds them again.')}
    </Box>
  )
}

/** The items of a map the latest prompt or conversation lacks, the most recently sent first. */
function rememberedNames(map: Record<string, { lastAt: number }>, latest: readonly string[]): string[] {
  const shown = new Set(latest)

  return Object.keys(map)
    .filter(name => !shown.has(name) && !name.startsWith(ADDED_PREFIX))
    .sort((a, b) => (map[b]?.lastAt ?? 0) - (map[a]?.lastAt ?? 0))
}

function rememberedGroup(view: View, kind: 'section' | 'context', names: string[], variant: PromptVariant | undefined, title: string, explanation: string): RenderElement {
  const { Box, Text } = view.ui

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{explanation}</Text>
      {listRows(view, kind, names, variant, true)}
    </Box>
  )
}

/** The order a list has of its own, as the sort picker names it: the order Claude Code sends the items in, or a history's. */
const AS_SENT = 'As Sent'
const BY_TIME = 'By Time'

/**
 * The picker over a tab's lists. `natural` names the order the lists have of their own; null where that order is by name
 * already, and the picker then offers only the two others.
 */
function sortPicker({ io, ui, control, state }: View, natural: string | null): RenderElement {
  const { Select } = ui
  const options = [...(natural === null ? [] : [{ value: 'natural', label: natural }]), { value: 'name', label: 'Alphabetical' }, { value: 'size', label: 'Biggest First' }]

  return <Select key="sort" label="Sort:" options={options} value={shownSort(state.listSort, natural !== null)} onSelect={value => void control.setListSort(io, value)} />
}

/** The order a list is shown in: one without an order of its own is shown by name for `natural`. */
function shownSort(sort: ListSort, hasOwnOrder: boolean): ListSort {
  return sort === 'natural' && !hasOwnOrder ? 'name' : sort
}

/** The items in the given order: `natural` keeps them as they came, `name` goes by the shown name, `size` puts the longest first. */
function sorted<T>(items: readonly T[], sort: ListSort, label: (item: T) => string, size: (item: T) => number): T[] {
  if (sort === 'natural') {
    return [...items]
  }
  const byName = (a: T, b: T): number => label(a).localeCompare(label(b))

  return [...items].sort(sort === 'size' ? (a, b) => size(b) - size(a) || byName(a, b) : byName)
}

/** A list of one kind's items in the picked order, sized by Claude Code's text as the rows show it. */
function sortItems({ control, state }: View, kind: Kind, names: readonly string[], hasOwnOrder: boolean, variant?: PromptVariant): string[] {
  return sorted(names, shownSort(state.listSort, hasOwnOrder), name => itemLabel(kind, name), name => (control.original(kind, name, variant) ?? '').length)
}

function itemList(view: View, kind: Kind, names: string[], explanation: string): RenderElement {
  const { Box, Text } = view.ui

  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{explanation}</Text>
      {names.length > 1 && sortPicker(view, null)}
      {names.length === 0 ? <Text dimColor>Nothing seen yet. Items show up here once Claude Code sends them.</Text> : listRows(view, kind, names)}
    </Box>
  )
}

function toolsTab(view: View): RenderElement {
  const { io, ui, control, state } = view
  const { Box, Input, Text } = ui
  const query = state.toolSearch.trim().toLowerCase()
  const names = sortItems(view, 'tool', Object.keys(control.store.catalog.tools).filter(name => query === '' || name.toLowerCase().includes(query)), false)

  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>The descriptions the model reads for each tool. Description changes apply to new conversations; a tool you remove is gone for the model from your next message on.</Text>
      <Input key="tool-search" label="Find a Tool:" placeholder="Name, e.g. Bash" value={state.toolSearch} onInput={value => void control.setToolSearch(io, value)} onSubmit={value => void control.setToolSearch(io, value)} />
      {Object.keys(control.store.catalog.tools).length > 1 && sortPicker(view, null)}
      {names.length === 0 ? <Text dimColor>{query === '' ? 'No tools seen yet.' : 'No tool matches that name.'}</Text> : listRows(view, 'tool', names)}
    </Box>
  )
}

function listRows({ io, ui, control }: View, kind: Kind, names: string[], variant?: PromptVariant, isRemembered = false): RenderElement {
  const { Box } = ui
  const rules = ruleMap(control.store.rules, kind)

  return (
    <Box flexDirection="column">
      {names.map(name => {
        const rule = rules[name]
        const inherited = rule === undefined ? inheritedRule(control.store.rules, kind, name) : undefined
        const details: Detail[] = [{ text: `${formatCount((control.original(kind, name, variant) ?? '').length)} characters`, tone: 'dim' }]
        const lastAt = isRemembered && (kind === 'section' || kind === 'context') ? control.seen(kind, name, variant)?.lastAt : undefined
        if (lastAt !== undefined) {
          details.push({ text: `last sent ${formatTime(lastAt)}`, tone: 'dim' })
        }
        if (control.isChanging(kind, name, variant)) {
          details.push({ text: 'changes per session', tone: 'info' })
        }
        if (rule !== undefined) {
          details.push(ruleDetail(kind, rule))
        } else if (inherited !== undefined) {
          details.push(ruleDetail(kind, inherited.rule, inherited.parent))
        }

        return listRow(ui, { key: `${kind}-${name}`, label: itemLabel(kind, name), onPress: () => void control.open(io, variant === undefined ? { kind, name } : { kind, name, variant }), details })
      })}
    </Box>
  )
}

/** A row's rule status, naming the item whose rule it follows when it has none of its own. */
function ruleDetail(kind: Kind, rule: Rule, parent?: string): Detail {
  const text = `${rule.mode === 'drop' ? (kind === 'tool' ? 'removed' : 'dropped') : 'edited'}${parent === undefined ? '' : ` with ${parent}`}`

  return { text, tone: rule.mode === 'drop' ? 'error' : 'warning' }
}

/** An item opened from its tab: its name, and the editor for it. */
function detail(view: View, target: Target): RenderElement {
  const { io, ui, control } = view
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Button key="back" label="Back" hotkey="b" onPress={() => void control.back(io)} />
        {targetTitle(ui, target)}
      </Box>
      {itemEditor(view, target)}
    </Box>
  )
}

/** An item's name, and what kind of item it is, in which prompt version. */
function targetTitle({ Text }: Ui, target: Target): RenderElement[] {
  return [
    <Text bold>{target.kind === 'added' ? ADDED_PREFIX + target.name : itemLabel(target.kind, target.name)}</Text>,
    <Text dimColor>{target.variant === undefined ? KIND_LABEL[target.kind] : `${KIND_LABEL[target.kind]} · ${VARIANT_LABEL[target.variant]}`}</Text>,
  ]
}

/**
 * Everything that can be done to an item, wherever it is opened from: what is sent of it now and why, Claude Code's
 * text, the editor in both modes, what the model gets with the edit, and the buttons to save, drop or reset it.
 */
function itemEditor({ io, ui, control, state }: View, target: Target): RenderElement {
  const { Box, Button, Code, Text } = ui
  const rule: Rule | undefined = target.kind === 'added' ? undefined : ruleMap(control.store.rules, target.kind)[target.name]
  const inherited = target.kind === 'added' || rule !== undefined ? undefined : inheritedRule(control.store.rules, target.kind, target.name)
  const followed = rule ?? inherited?.rule
  const relation = target.kind === 'attachment' ? RELATION_HINT[target.name] : undefined
  const original = target.kind === 'added' ? undefined : control.original(target.kind, target.name, target.variant)
  const isInBothVersions = target.kind === 'section' && VARIANT_ORDER.filter(variant => control.store.catalog.prompts[variant]?.sections[target.name] !== undefined).length > 1
  const isChanging = target.kind !== 'added' && control.isChanging(target.kind, target.name, target.variant)
  const editor = control.editorFor(target, state.draft)
  const isUnsaved = control.isUnsaved(target, state.draft)
  const preview = original === undefined ? null : editor.mode === 'patch' ? applyPatches(original, editor.patches) : editor.text.includes(ORIGINAL_TOKEN) ? fillOriginal(editor.text, original) : null

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={followed?.mode === 'drop' ? 'error' : followed === undefined ? 'subtle' : 'warning'}>{inherited === undefined ? statusText(target, rule) : `${statusText(target, inherited.rule)}, as it follows your edit of ${inherited.parent}`}</Text>
      {relation !== undefined && <Text dimColor>{relation}</Text>}
      {isInBothVersions && <Text dimColor>This section is in both prompt versions, so your edit applies to both. The text below is this version's.</Text>}
      {isChanging && <Text color="suggestion">This text changes between sessions. Find & Replace keeps the changing parts current; Full Replacement freezes them unless it uses {ORIGINAL_TOKEN}.</Text>}
      {original !== undefined && (
        <Box flexDirection="column">
          <Text bold>{`Claude Code's Text (${formatCount(original.length)} Characters)`}</Text>
          <Code source={original} language="markdown" wrap="wrap" />
        </Box>
      )}
      <Box flexDirection="column" gap={1}>
        <Text bold>Your Change</Text>
        {target.kind !== 'added' && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="edit-full" label="Full Replacement" variant={editor.mode === 'full' ? 'primary' : 'secondary'} onPress={() => void control.setEditMode(io, target, 'full')} />
            <Button key="edit-patch" label="Find & Replace" variant={editor.mode === 'patch' ? 'primary' : 'secondary'} onPress={() => void control.setEditMode(io, target, 'patch')} />
          </Box>
        )}
        {editor.mode === 'full' || target.kind === 'added' ? fullEditor({ io, ui, control, state }, target, editor) : patchEditor({ io, ui, control, state }, target, editor, original)}
        <Text dimColor>Enter saves. Add a new line the way you do in the message box.</Text>
      </Box>
      {preview !== null && (
        <Box flexDirection="column">
          <Text bold>{`What the Model Gets Now (${formatCount(preview.length)} Characters)`}</Text>
          <Code source={preview} language="markdown" wrap="wrap" />
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="save" label="Save" variant="primary" onPress={() => void control.save(io, target)} />
        {isUnsaved && <Button key="discard" label="Discard Changes" onPress={() => void control.discardDraft(io)} />}
        {target.kind === 'added' && <Button key="delete" label="Delete Section" onPress={() => void control.drop(io, target)} />}
        {target.kind !== 'added' && followed?.mode !== 'drop' && <Button key="drop" label={target.kind === 'tool' ? 'Remove Tool' : 'Drop It'} onPress={() => void control.drop(io, target)} />}
        {target.kind !== 'added' && rule !== undefined && <Button key="reset" label="Reset to Original" onPress={() => void control.reset(io, target)} />}
      </Box>
    </Box>
  )
}

function fullEditor({ io, ui, control }: View, target: Target, editor: Draft): RenderElement {
  const { Box, Input, Text } = ui

  return (
    <Box flexDirection="column">
      {target.kind !== 'added' && <Text dimColor>{`Your text replaces Claude Code's whole text. Write ${ORIGINAL_TOKEN} where its current text should go.`}</Text>}
      <Input key={`editor-${draftKey(target)}`} rows={EDITOR_ROWS} value={editor.text} placeholder="Write the text the model should get" onInput={value => void control.setDraftText(io, target, value)} onSubmit={value => void control.setDraftText(io, target, value).then(() => control.save(io, target))} />
    </Box>
  )
}

function patchEditor({ io, ui, control }: View, target: Target, editor: Draft, original: string | undefined): RenderElement {
  const { Box, Button, Input, Text } = ui

  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Each pair changes Claude Code's current text every time it is sent, so the parts that change between sessions stay current. Pairs apply in order.</Text>
      {editor.patches.map((patch, index) => {
        const matches = original === undefined ? null : countMatches(original, patch.find)

        return (
          <Box key={`patch-${index}`} flexDirection="column">
            <Input key={`find-${index}`} label="Find:" rows={PATCH_ROWS} value={patch.find} placeholder="Text exactly as Claude Code writes it" onInput={value => void control.setPatch(io, target, index, 'find', value)} onSubmit={value => void control.setPatch(io, target, index, 'find', value).then(() => control.save(io, target))} />
            <Input key={`replace-${index}`} label="Replace With:" rows={PATCH_ROWS} value={patch.replace} placeholder="Leave empty to remove the text" onInput={value => void control.setPatch(io, target, index, 'replace', value)} onSubmit={value => void control.setPatch(io, target, index, 'replace', value).then(() => control.save(io, target))} />
            <Box flexDirection="row" columnGap={1} alignItems="center">
              {patch.find !== '' && matches !== null && (matches === 0 ? <Text color="error">Not found in Claude Code's current text</Text> : <Text dimColor>{matches === 1 ? 'Found once' : `Found ${matches} times`}</Text>)}
              <Button key={`remove-patch-${index}`} label="Remove Pair" plain dimColor onPress={() => void control.removePatch(io, target, index)} />
            </Box>
          </Box>
        )
      })}
      <Box>
        <Button key="add-patch" label="Add a Pair" onPress={() => void control.addPatch(io, target)} />
      </Box>
    </Box>
  )
}

function statusText(target: Target, rule: Rule | undefined): string {
  if (target.kind === 'added') {
    return "Sent after Claude Code's own sections"
  }
  switch (rule?.mode) {
    case undefined:
      return 'Sent as Claude Code made it'
    case 'drop':
      return target.kind === 'tool' ? "Removed: the model can't use this tool" : 'Dropped: not sent'
    case 'replace':
      return 'Edited: your full replacement is sent'
    case 'patch':
      return `Edited: ${rule.patches.length === 1 ? '1 find & replace pair applies' : `${rule.patches.length} find & replace pairs apply`}`
  }
}

function desktopTab({ ui, control }: View): RenderElement {
  const { Box, Code, Text } = ui
  if (!control.isDesktopLoaded) {
    return <Text dimColor>Reading the desktop app's session files…</Text>
  }
  if (control.desktop === null) {
    return <Text dimColor>No desktop app instructions found for this session. They exist only for sessions the Claude desktop app started.</Text>
  }
  const title = control.desktop.sessionTitle === '' ? '' : ` ("${control.desktop.sessionTitle}")`

  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>{`What the desktop app adds to the system prompt of this session${title}. Read-only: the app adds it past every point a mod can change.`}</Text>
      <Text bold>{`${formatCount(control.desktop.text.length)} Characters`}</Text>
      <Code source={control.desktop.text.trim()} language="markdown" wrap="wrap" />
    </Box>
  )
}

function historyTab(view: View): RenderElement {
  const { io, ui, control, state } = view
  const { Box, Button, Text } = ui
  if (state.historySession !== null) {
    return historySessionView(view, state.historySession)
  }
  if (control.histories === null) {
    return <Text dimColor>Reading the history…</Text>
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text dimColor>Everything Claude Code sent the model besides your own messages, per session: system prompt sections, first-message context and injected messages, with what your edits did to them, and how often each injected message was added to the conversation.</Text>
        <Button key="refresh-history" label="Refresh" hotkey="r" onPress={() => void control.loadHistories(io)} />
      </Box>
      {control.histories.length === 0 ? (
        <Text dimColor>No history yet.</Text>
      ) : (
        <Box flexDirection="column">
          {control.histories.map(one => (
            listRow(ui, { key: `session-${one.sessionId}`, label: formatTime(one.lastAt), onPress: () => void control.openHistory(io, one.sessionId), details: [{ text: `${folderName(one.cwd)} · ${one.itemCount} ${one.itemCount === 1 ? 'item' : 'items'}`, tone: 'dim' }] })
          ))}
        </Box>
      )}
    </Box>
  )
}

function historySessionView(view: View, sessionId: string): RenderElement {
  const { io, ui, control, state } = view
  const { Box, Button, Code, Input, Text } = ui
  const history = control.openedHistory
  if (history === null || history.sessionId !== sessionId) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Button key="sessions" label="All Sessions" hotkey="b" onPress={() => void control.openHistory(io, null)} />
        </Box>
        <Text dimColor>This session's history could not be read.</Text>
      </Box>
    )
  }
  const item = state.historyItem === null ? undefined : history.items[state.historyItem]
  if (item !== undefined) {
    return historyItemView(view, item)
  }
  const query = state.historySearch.trim().toLowerCase()
  const matching = history.items
    .map((one, index) => ({ one, index }))
    .filter(({ one }) => query === '' || itemLabel(one.kind, one.name).toLowerCase().includes(query) || KIND_LABEL[one.kind].toLowerCase().includes(query))
    .sort((a, b) => a.one.firstAt - b.one.firstAt)
  const rows = sorted(matching, shownSort(state.listSort, true), ({ one }) => itemLabel(one.kind, one.name), ({ one }) => one.length)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Button key="sessions" label="All Sessions" hotkey="b" onPress={() => void control.openHistory(io, null)} />
        <Text bold>{folderName(history.cwd)}</Text>
        <Text dimColor>{`${formatTime(history.startedAt)} to ${formatTime(history.lastAt)}`}</Text>
      </Box>
      <Input key="history-search" label="Filter:" placeholder="Name or kind, e.g. reminder" value={state.historySearch} onInput={value => void control.setHistorySearch(io, value)} onSubmit={value => void control.setHistorySearch(io, value)} />
      {history.items.length > 1 && sortPicker(view, BY_TIME)}
      {rows.length === 0 ? <Text dimColor>Nothing matches.</Text> : <Box flexDirection="column">{rows.map(({ one, index }) => historyRow(view, one, index))}</Box>}
    </Box>
  )
}

/**
 * One item of a session's history: what happened to it then, and the same editor its own tab has, so it can be edited,
 * dropped or reset from here. The text of that session shows only where it differs from Claude Code's latest, which the
 * editor shows.
 */
function historyItemView(view: View, item: HistoryItem): RenderElement {
  const { io, ui, control } = view
  const { Box, Button, Code, Text } = ui
  const target = historyTarget(control, item)
  const text = control.texts.get(item.hash)
  const latest = target === null || target.kind === 'added' ? undefined : control.original(target.kind, target.name, target.variant)
  const added = item.count === 0 ? '' : ` · added to the conversation ${item.count === 1 ? 'once' : `${item.count} times`}`
  const when = `first ${formatTime(item.firstAt)}${item.lastAt > item.firstAt ? `, last ${formatTime(item.lastAt)}` : ''}`

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Button key="items" label="Back" hotkey="b" onPress={() => void control.openHistoryItem(io, null)} />
        {target === null ? [<Text bold>{itemLabel(item.kind, item.name)}</Text>, <Text dimColor>{KIND_LABEL[item.kind]}</Text>] : targetTitle(ui, target)}
      </Box>
      <Text color={actionColor(item.action)}>{`In this session: ${SESSION_ACTION[item.action]}${added} · ${when}${item.agentId === undefined ? '' : ' · in a subagent'}`}</Text>
      {text === undefined || text === null ? (
        <Text dimColor>The text of this session could not be read.</Text>
      ) : (
        text !== latest && (
          <Box flexDirection="column">
            <Text bold>{`Text in This Session (${formatCount(text.length)} Characters)`}</Text>
            <Code source={text} language="markdown" wrap="wrap" />
          </Box>
        )
      )}
      {target === null ? <Text dimColor>This section of yours has been deleted since.</Text> : itemEditor(view, target)}
    </Box>
  )
}

/** The item a history entry is of, as its tab opens it; null for a section of the user's own that no longer exists. */
function historyTarget(control: TweakerController, item: HistoryItem): Target | null {
  if (item.kind === 'section' && item.name.startsWith(ADDED_PREFIX)) {
    const id = item.name.slice(ADDED_PREFIX.length)

    return control.store.rules.added.some(one => one.id === id) ? { kind: 'added', name: id } : null
  }

  return item.variant === undefined ? { kind: item.kind, name: item.name } : { kind: item.kind, name: item.name, variant: item.variant }
}

function historyRow({ io, ui, control }: View, item: HistoryItem, index: number): RenderElement {
  const details: Detail[] = [{ text: `${shortKind(item.kind)} · ${formatCount(item.length)} chars${item.count > 1 ? ` · ×${item.count}` : ''}`, tone: 'dim' }]
  if (item.action !== 'sent') {
    details.push({ text: actionLabel(item.action).toLowerCase(), tone: actionTone(item.action) })
  }

  return listRow(ui, { key: `item-${index}`, label: `${formatClock(item.firstAt)} ${itemLabel(item.kind, item.name)}`, onPress: () => void control.openHistoryItem(io, index), details })
}

function ruleCount(control: TweakerController): number {
  const rules = control.store.rules

  return Object.keys(rules.sections).length + Object.keys(rules.context).length + Object.keys(rules.attachments).length + Object.keys(rules.tools).length + rules.added.filter(one => one.text.trim() !== '').length
}

/** What happened to an item in a past session, said beside what its rule does now. */
const SESSION_ACTION: Record<Action, string> = { sent: 'sent as made', edited: 'replaced by your edit', dropped: 'dropped by your edit', added: 'sent as your own section' }

function actionLabel(action: Action): string {
  return action === 'dropped' ? 'Dropped by your edit' : action === 'edited' ? 'Replaced by your edit' : action === 'added' ? 'Your own section' : 'Sent as made'
}

function actionColor(action: Action): 'error' | 'warning' | 'success' | 'subtle' {
  return action === 'sent' ? 'subtle' : actionTone(action)
}

function actionTone(action: Exclude<Action, 'sent'>): 'error' | 'warning' | 'success' {
  return action === 'dropped' ? 'error' : action === 'edited' ? 'warning' : 'success'
}

/** The name an item is shown under: Claude Code's own, except for the re-read instruction copies the mod keeps apart. */
function itemLabel(kind: Kind, name: string): string {
  return kind === 'attachment' && name === REREAD_INSTRUCTIONS ? `${INSTRUCTIONS} (re-read copies)` : name
}

function shortKind(kind: Kind): string {
  return kind === 'section' ? 'prompt' : kind === 'attachment' ? 'injected' : kind
}

function folderName(path: string): string {
  return path.split('/').filter(part => part !== '').pop() ?? path
}

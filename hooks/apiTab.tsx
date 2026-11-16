import type { RenderElement } from 'claude-code'

import type { ApiSection, ExchangeSummary } from '../types'
import type { TweakerController } from './controller'
import type { Io, PaneState } from './io'
import type { OpenedExchange } from './recordings'
import type { Detail, Ui } from './ui'
import { formatClock, formatCount, formatTime, listRow } from './ui'

type ApiView = { io: Io; ui: Ui; control: TweakerController; state: PaneState }

/** The path of a model request: anything else (counting tokens, listing models) says its path in the list. */
const MESSAGES_PATH = '/v1/messages'

/** The parts of an exchange in the order a request is read, then its response. */
const SECTIONS: { id: ApiSection; label: string; language: string }[] = [
  { id: 'headers', label: 'Headers', language: 'http' },
  { id: 'fields', label: 'Request Fields', language: 'json' },
  { id: 'system', label: 'System Prompt', language: 'json' },
  { id: 'tools', label: 'Tools', language: 'json' },
  { id: 'newMessages', label: 'New Messages', language: 'json' },
  { id: 'allMessages', label: 'All Messages', language: 'json' },
  { id: 'response', label: 'Response', language: 'text' },
]

/** The API Traffic tab: this session's exchanges with the Anthropic API, newest first, and one of them in full. */
export function renderApiTab(view: ApiView): RenderElement {
  return view.state.apiItem === null ? exchangeList(view) : exchangeDetail(view, view.state.apiItem)
}

function exchangeList(view: ApiView): RenderElement {
  const { io, ui, control } = view
  const { Box, Button, Text } = ui
  const summaries = control.api.summaries

  return (
    <Box flexDirection="column" gap={1}>
      {recordingLine(view)}
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Text dimColor>The exact requests this session sent to the Anthropic API and what came back, newest first. Login tokens are never saved.</Text>
        <Button key="refresh-api" label="Refresh" hotkey="r" onPress={() => void control.refreshApi(io)} />
      </Box>
      {summaries === null ? (
        <Text dimColor>Reading the recordings…</Text>
      ) : summaries.length === 0 ? (
        <Text dimColor>Nothing recorded in this session. Only sessions started while recording is on go through the recorder.</Text>
      ) : (
        <Box flexDirection="column">{summaries.map(one => exchangeRow(view, one))}</Box>
      )}
    </Box>
  )
}

/** Whether sessions go through the recorder, with the switch, and a warning when they would but it is not running. */
function recordingLine({ io, ui, control }: ApiView): RenderElement {
  const { Box, Button, Text } = ui
  const api = control.api
  if (api.recording === 'unknown') {
    return <Text color="error">Couldn't read ~/.claude/settings.json as JSON, so recording can't be switched here.</Text>
  }
  if (api.recording === 'other') {
    return <Text color="warning">Claude Code goes through a proxy or certificate file of yours, so the recorder can't be put in.</Text>
  }
  if (api.isBusy) {
    return <Text dimColor>Switching the recorder…</Text>
  }
  const isOn = api.recording === 'on'
  const isDown = isOn && api.isRecorderUp === false
  const text = isDown ? "The recorder isn't running: sessions you start now can't reach the API." : isOn ? 'Recording every session you start.' : 'Not recording.'

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      <Text color={isDown ? 'error' : isOn ? 'success' : 'subtle'}>{text}</Text>
      {isDown && <Button key="restart-recorder" label="Start the Recorder" variant="primary" onPress={() => void control.setRecording(io, true)} />}
      <Button key="recording" label={isOn ? 'Stop Recording' : 'Start Recording'} onPress={() => void control.setRecording(io, !isOn)} />
    </Box>
  )
}

function exchangeRow({ io, ui, control }: ApiView, one: ExchangeSummary): RenderElement {
  const path = one.path.split('?')[0] ?? one.path
  const details: Detail[] = []
  if (one.status !== 200) {
    details.push({ text: one.status === null ? (one.error ?? 'no response') : `${one.status}${one.errorType === null ? '' : ` ${one.errorType}`}`, tone: 'error' })
  }
  details.push(...usageDetails(one), { text: seconds(one.durationMs), tone: 'dim' })
  const label = `${formatClock(one.at)} ${one.model ?? ''}${path === MESSAGES_PATH ? '' : ` ${path}`}`.trim()

  return listRow(ui, { key: `exchange-${one.n}`, label, onPress: () => void control.openExchange(io, one.n), details })
}

/** The tokens of a response: everything the request was read as, of it what the cache served, and what came out. */
function usageDetails(one: ExchangeSummary): Detail[] {
  const usage = one.usage
  if (usage === null) {
    return []
  }
  const cached = usage.cacheRead ?? 0
  const input = (usage.input ?? 0) + cached + (usage.cacheWrite ?? 0)
  const details: Detail[] = [{ text: `${formatCount(input)} in${cached > 0 ? ` (${formatCount(cached)} cached)` : ''}`, tone: 'dim' }]
  if (usage.output !== null) {
    details.push({ text: `${formatCount(usage.output)} out`, tone: 'dim' })
  }

  return details
}

function exchangeDetail(view: ApiView, n: number): RenderElement {
  const { io, ui, control } = view
  const { Box, Button, Text } = ui
  const opened = control.api.opened?.exchange.n === n ? control.api.opened : null
  const summary = control.api.summaries?.find(one => one.n === n)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        <Button key="api-back" label="Back" hotkey="b" onPress={() => void control.openExchange(io, null)} />
        <Text bold>{`#${n} ${summary?.model ?? ''}`.trim()}</Text>
        {summary !== undefined && <Text dimColor>{formatTime(summary.at)}</Text>}
      </Box>
      {opened === null ? <Text dimColor>{control.api.isOpenMissing ? 'This exchange could not be read.' : 'Reading the exchange…'}</Text> : exchangeParts(view, opened)}
    </Box>
  )
}

function exchangeParts(view: ApiView, opened: OpenedExchange): RenderElement {
  const { ui } = view
  const { Box, Text } = ui
  const { exchange } = opened
  const body = exchange.request.body
  const messageCount = body.messages?.length ?? 0
  const facts = [
    exchange.status === null ? (exchange.error ?? 'no response') : `HTTP ${exchange.status}`,
    exchange.stopReason,
    ...usageDetails(exchange).map(detail => detail.text),
    seconds(exchange.durationMs),
    `request ${bytes(exchange.requestBytes)}, response ${bytes(exchange.responseBytes)}`,
  ].filter((fact): fact is string => fact !== null && fact !== '')
  const shown = SECTIONS.filter(section => {
    switch (section.id) {
      case 'system':
        return body.system !== undefined
      case 'tools':
        return body.tools !== undefined
      case 'newMessages':
      case 'allMessages':
        return body.messages !== undefined
      default:
        return true
    }
  })
  const counted = (section: (typeof SECTIONS)[number]): string =>
    section.id === 'newMessages' ? `${section.label} (${opened.newMessageCount})` : section.id === 'allMessages' ? `${section.label} (${messageCount})` : section.label

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={exchange.status === 200 ? 'subtle' : 'error'}>{facts.join(' · ')}</Text>
      {shown.map(section => sectionView(view, opened, section.id, counted(section), section.language))}
    </Box>
  )
}

/** One part of an exchange: its name opens and closes it, its text shows once read. */
function sectionView({ io, ui, control, state }: ApiView, opened: OpenedExchange, id: ApiSection, label: string, language: string): RenderElement {
  const { Box, Button, Code, Text } = ui
  const isOpen = state.apiExpanded.includes(id)
  const text = opened.texts.get(id)

  return (
    <Box key={`part-${id}`} flexDirection="column">
      <Box>
        <Button key={`section-${id}`} label={`${isOpen ? '▾' : '▸'} ${label}`} plain onPress={() => void control.toggleApiSection(io, id)} />
      </Box>
      {isOpen && (text === undefined ? <Text dimColor>Reading…</Text> : text === '' ? <Text dimColor>Empty.</Text> : <Code source={text} language={language} wrap="wrap" />)}
    </Box>
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function bytes(count: number): string {
  return count < 1024 ? `${count} B` : count < 1024 * 1024 ? `${(count / 1024).toFixed(1)} KB` : `${(count / 1024 / 1024).toFixed(1)} MB`
}

import type { ApiSection, Exchange, ExchangeSummary, Notice, RecorderInfo } from '../types'
import type { Io } from './io'
import type { RecordingState } from './settings'
import { isObject, readSettings, recordingStateOf, SETTINGS_UNREADABLE, withRecording, writeSettings } from './settings'

/** The parts of an exchange shown open when it is opened: what tells the most at a glance, without the bulk. */
export const DEFAULT_SECTIONS: readonly ApiSection[] = ['fields', 'newMessages', 'response']

/** Waits after a turn before the list is read again: the recorder writes an exchange once its response has ended. */
const REFRESH_AFTER_TURN_MS = 1500

/** An exchange opened in full: its record, and the text of each part read so far. */
export type OpenedExchange = {
  exchange: Exchange
  /** How many of the request's messages the request before it in the session did not send. */
  newMessageCount: number
  texts: Map<ApiSection, string>
}

/** What `recorder.sh` answers, one JSON line. */
type ScriptResult = { ok: boolean; error?: string; listening?: boolean }

/**
 * The API Traffic tab's data: whether sessions go through the recorder, and what it recorded of this session, read from
 * the recordings folder record.py writes (see recorder/record.py for its layout).
 */
export class ApiTraffic {

  recorder: RecorderInfo | null = null
  recording: RecordingState | 'unknown' = 'unknown'
  /** Whether the recorder answers on its port; null while not asked, as when recording is off. */
  isRecorderUp: boolean | null = null
  /** This session's exchanges, newest first; null until read. */
  summaries: ExchangeSummary[] | null = null
  opened: OpenedExchange | null = null
  /** Whether the exchange asked for had no readable file. */
  isOpenMissing = false
  isBusy = false
  private isLoaded = false

  /** Reads where the recorder stands and what it recorded of this session. */
  async load(io: Io): Promise<void> {
    this.isLoaded = true
    this.recorder = await readRecorder(io)
    const settings = await readSettings(io)
    this.recording = settings === undefined ? 'unknown' : recordingStateOf(settings ?? {}, this.recorder)
    this.isRecorderUp = this.recording === 'on' ? (await runScript(io, 'status')).listening === true : null
    await this.refresh(io)
  }

  /** Reads this session's list of exchanges again. */
  async refresh(io: Io): Promise<void> {
    this.summaries = this.recorder === null ? [] : await readSummaries(io, this.recorder, await io.sessionId())
    await io.set.redraw()
  }

  /** Reads the list again a little after a turn, once the panel has shown the tab. */
  refreshAfterTurn(io: Io): void {
    if (this.isLoaded) {
      io.after(REFRESH_AFTER_TURN_MS, () => void this.refresh(io))
    }
  }

  async open(io: Io, n: number | null): Promise<void> {
    this.opened = null
    this.isOpenMissing = false
    await io.set.apiExpanded([...DEFAULT_SECTIONS])
    await io.set.apiItem(n)
    if (n === null || this.recorder === null) {
      return
    }
    const sessionId = await io.sessionId()
    const exchange = await readExchange(io, this.recorder, sessionId, n)
    if (exchange === null) {
      this.isOpenMissing = true
      await io.set.redraw()

      return
    }
    const before = n > 1 ? await readExchange(io, this.recorder, sessionId, n - 1) : null
    this.opened = { exchange, newMessageCount: newMessageCount(exchange, before), texts: new Map() }
    for (const section of DEFAULT_SECTIONS) {
      await this.loadSection(io, section)
    }
    await io.set.redraw()
  }

  /** Opens or closes a part of the opened exchange, reading its text the first time it opens. */
  async toggleSection(io: Io, section: ApiSection): Promise<void> {
    let isOpening = false
    await io.set.updateApiExpanded(current => {
      isOpening = !current.includes(section)

      return isOpening ? [...current, section] : current.filter(one => one !== section)
    })
    if (isOpening) {
      await this.loadSection(io, section)
      await io.set.redraw()
    }
  }

  /** Sends sessions started from now on through the recorder, or straight to the API again. */
  async setRecording(io: Io, isOn: boolean): Promise<Notice> {
    const settings = await readSettings(io)
    if (settings === undefined) {
      return { text: SETTINGS_UNREADABLE, isError: true }
    }
    this.isBusy = true
    await io.set.redraw()
    try {
      return isOn ? await this.start(io, settings ?? {}) : await this.stop(io, settings ?? {})
    } finally {
      this.isBusy = false
      await this.load(io)
    }
  }

  private async start(io: Io, settings: Record<string, unknown>): Promise<Notice> {
    if (recordingStateOf(settings, await readRecorder(io)) === 'other') {
      return { text: "Claude Code already goes through a proxy or certificate file of yours (HTTPS_PROXY or NODE_EXTRA_CA_CERTS in ~/.claude/settings.json), so the recorder can't be put in.", isError: true }
    }
    const started = await runScript(io, 'start')
    const recorder = await readRecorder(io)
    if (!started.ok || recorder === null) {
      return { text: `The recorder didn't start: ${started.error ?? 'it left no address behind'}.`, isError: true }
    }
    await writeSettings(io, withRecording(settings, recorder, true))

    return { text: 'Recording sessions you start from now on. This one reaches the API directly, as it started before.', isError: false }
  }

  private async stop(io: Io, settings: Record<string, unknown>): Promise<Notice> {
    const recorder = this.recorder ?? (await readRecorder(io))
    if (recorder !== null) {
      await writeSettings(io, withRecording(settings, recorder, false))
    }
    await runScript(io, 'retire')

    return { text: 'Sessions you start from now on reach the API directly. Those started while recording was on keep going through the recorder until they end; it no longer starts at login.', isError: false }
  }

  private async loadSection(io: Io, section: ApiSection): Promise<void> {
    const opened = this.opened
    if (opened === null || this.recorder === null || opened.texts.has(section)) {
      return
    }
    const text = await sectionText(io, this.recorder, opened, section)
    opened.texts.set(section, text)
  }

}

/** The text of one part of an exchange, as its detail view shows it: JSON laid out, the response as it came. */
async function sectionText(io: Io, recorder: RecorderInfo, opened: OpenedExchange, section: ApiSection): Promise<string> {
  const { exchange, newMessageCount } = opened
  const body = exchange.request.body
  const blob = (hash: string | undefined): Promise<string> => (hash === undefined ? Promise.resolve('') : readBlob(io, recorder, hash))
  switch (section) {
    case 'headers':
      return `${exchange.method} ${exchange.path}\n${headerLines(exchange.request.headers)}\n\nHTTP ${exchange.status ?? '(none)'}\n${headerLines(exchange.response.headers)}`
    case 'fields':
      return body.text !== undefined ? pretty(await blob(body.text)) : JSON.stringify(body.fields ?? {}, null, 2)
    case 'system':
      return pretty(await blob(body.system))
    case 'tools':
      return pretty(await blob(body.tools))
    case 'newMessages':
      return messagesText(io, recorder, (body.messages ?? []).slice((body.messages ?? []).length - newMessageCount))
    case 'allMessages':
      return messagesText(io, recorder, body.messages ?? [])
    case 'response':
      return exchange.response.body === null ? '' : blob(exchange.response.body)
  }
}

async function messagesText(io: Io, recorder: RecorderInfo, hashes: readonly string[]): Promise<string> {
  const messages: unknown[] = []
  for (const hash of hashes) {
    messages.push(parseJson(await readBlob(io, recorder, hash)))
  }

  return JSON.stringify(messages, null, 2)
}

/**
 * How many of a request's messages the request before it did not send: what follows the messages both share from the
 * start. A compaction rewrites the conversation, so then every message counts as new.
 */
export function newMessageCount(exchange: Exchange, before: Exchange | null): number {
  const messages = exchange.request.body.messages ?? []
  const earlier = before?.request.body.messages ?? []
  let shared = 0
  while (shared < messages.length && shared < earlier.length && messages[shared] === earlier[shared]) {
    shared += 1
  }

  return messages.length - shared
}

/** The exchanges of one session, newest first; a line that does not parse is left out. */
export function parseSummaries(text: string): ExchangeSummary[] {
  const summaries: ExchangeSummary[] = []
  for (const line of text.split('\n')) {
    const parsed = parseJson(line)
    if (isObject(parsed) && typeof parsed.n === 'number' && typeof parsed.at === 'number') {
      summaries.push(parsed as ExchangeSummary)
    }
  }

  return summaries.sort((a, b) => b.at - a.at || b.n - a.n)
}

async function readSummaries(io: Io, recorder: RecorderInfo, sessionId: string): Promise<ExchangeSummary[]> {
  const text = await io.readFile(`${sessionFolder(recorder, sessionId)}/index.jsonl`).catch(() => '')

  return parseSummaries(text)
}

async function readExchange(io: Io, recorder: RecorderInfo, sessionId: string, n: number): Promise<Exchange | null> {
  const parsed = parseJson(await io.readFile(`${sessionFolder(recorder, sessionId)}/${n}.json`).catch(() => ''))

  return isObject(parsed) && isObject(parsed.request) && isObject(parsed.response) ? (parsed as Exchange) : null
}

async function readBlob(io: Io, recorder: RecorderInfo, hash: string): Promise<string> {
  return io.readFile(`${recorder.dir}/blobs/${hash.slice(0, 2)}/${hash}.json`).catch(() => '')
}

async function readRecorder(io: Io): Promise<RecorderInfo | null> {
  const parsed = parseJson(await io.readFile(`${await io.home()}/.claude/prompt-tweaker/recorder.json`).catch(() => ''))
  if (!isObject(parsed) || typeof parsed.dir !== 'string' || typeof parsed.proxy !== 'string' || typeof parsed.ca !== 'string' || typeof parsed.port !== 'number') {
    return null
  }

  return { dir: parsed.dir, port: parsed.port, proxy: parsed.proxy, ca: parsed.ca }
}

/** Runs recorder.sh, which ships with the mod, and reads the JSON line it answers. */
async function runScript(io: Io, command: 'start' | 'retire' | 'status'): Promise<ScriptResult> {
  try {
    const { stdout, stderr } = await io.run(['/bin/bash', `${io.pluginRoot()}/recorder/recorder.sh`, command])
    const parsed = parseJson(stdout.trim().split('\n').pop() ?? '')

    return isObject(parsed) && typeof parsed.ok === 'boolean' ? (parsed as ScriptResult) : { ok: false, error: stderr.trim() || 'it answered nothing' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Session ids come from the recorder's folder names, which it keeps to letters, digits, `-` and `_`. */
function sessionFolder(recorder: RecorderInfo, sessionId: string): string {
  return `${recorder.dir}/sessions/${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

function headerLines(headers: readonly [string, string][]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join('\n')
}

function pretty(text: string): string {
  const parsed = parseJson(text)

  return parsed === undefined ? text : JSON.stringify(parsed, null, 2)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

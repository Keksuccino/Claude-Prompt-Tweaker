import type { Io } from './io'
import { isObject } from './settings'

/** The instructions the desktop app appended to a session's system prompt, as the app's own session file keeps them. */
export type DesktopAppend = { text: string; sessionTitle: string }

/** The desktop app's session files are many; the current one is among the most recently written, so only these are read. */
const MAX_FILES_READ = 60

/**
 * Finds the desktop app's snapshot of what it appended to this session's system prompt. The app keeps one file per session
 * under `claude-code-sessions/<org>/<account>/local_<id>.json`, naming the CLI session it runs in `cliSessionId`.
 * Read-only: the app passes this text to Claude Code as an appended prompt, past every hook a mod could change it in.
 */
export async function readDesktopAppend(io: Io): Promise<DesktopAppend | null> {
  const root = `${await io.home()}/Library/Application Support/Claude/claude-code-sessions`
  const sessionId = await io.sessionId()
  const cwd = await io.cwd()
  const files: { path: string; mtimeMs: number }[] = []
  for (const org of await listDirectories(io, root)) {
    for (const account of await listDirectories(io, `${root}/${org}`)) {
      const folder = `${root}/${org}/${account}`
      for (const entry of await io.listDir(folder).catch(() => [])) {
        if (entry.kind === 'file' && entry.name.startsWith('local_') && entry.name.endsWith('.json')) {
          files.push({ path: `${folder}/${entry.name}`, mtimeMs: entry.mtimeMs })
        }
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let sameFolder: DesktopAppend | null = null
  for (const file of files.slice(0, MAX_FILES_READ)) {
    const session = await readSession(io, file.path)
    if (session === null) {
      continue
    }
    if (session.cliSessionIds.includes(sessionId)) {
      return session.append
    }
    // A session the app resumed may run under a new CLI id the app has not written yet: the newest one in this folder stands in.
    if (sameFolder === null && session.cwd === cwd) {
      sameFolder = session.append
    }
  }

  return sameFolder
}

async function listDirectories(io: Io, path: string): Promise<string[]> {
  const entries = await io.listDir(path).catch(() => [])

  return entries.filter(entry => entry.kind === 'dir').map(entry => entry.name)
}

async function readSession(io: Io, path: string): Promise<{ cliSessionIds: string[]; cwd: string; append: DesktopAppend } | null> {
  try {
    const raw: unknown = JSON.parse(await io.readFile(path))
    if (!isObject(raw) || !isObject(raw.promptAppendSnapshot) || typeof raw.promptAppendSnapshot.append !== 'string') {
      return null
    }
    const ids = [raw.cliSessionId, raw.lastAssistantCliSessionId].filter((id): id is string => typeof id === 'string')

    return { cliSessionIds: ids, cwd: typeof raw.cwd === 'string' ? raw.cwd : '', append: { text: raw.promptAppendSnapshot.append, sessionTitle: typeof raw.title === 'string' ? raw.title : '' } }
  } catch {
    return null
  }
}

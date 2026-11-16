import type { PromptMode, PromptModeState } from '../types'
import type { Io } from './io'

/**
 * Claude Code reads this variable before its own per-model choice of system prompt: a true value (`1`) gives every model
 * the short prompt, a false value (`0`) the full one, and without it Claude Code picks per model. It is read once per
 * session, so a change applies to sessions started after it.
 */
export const PROMPT_MODE_VARIABLE = 'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT'

// The spellings Claude Code itself accepts for a true and a false value of the variable.
const TRUE_VALUES = ['1', 'true', 'yes', 'on']
const FALSE_VALUES = ['0', 'false', 'no', 'off']

/** Reads the prompt mode from the user's settings object. */
export function promptModeOf(settings: unknown): PromptModeState {
  if (!isObject(settings)) {
    return 'unknown'
  }
  const env = settings.env
  const value = isObject(env) ? env[PROMPT_MODE_VARIABLE] : undefined
  const spelled = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (TRUE_VALUES.includes(spelled)) {
    return 'short'
  }

  return FALSE_VALUES.includes(spelled) ? 'full' : 'default'
}

/** Returns the settings with the prompt mode set, every other key left as it was. */
export function withPromptMode(settings: Record<string, unknown>, mode: PromptMode): Record<string, unknown> {
  return withEnv(settings, env => {
    if (mode === 'default') {
      delete env[PROMPT_MODE_VARIABLE]
    } else {
      env[PROMPT_MODE_VARIABLE] = mode === 'short' ? '1' : '0'
    }
  })
}

/** Said when ~/.claude/settings.json is no JSON object, which nothing here writes over. */
export const SETTINGS_UNREADABLE = "Couldn't read ~/.claude/settings.json as JSON, so nothing was changed."

/** The user's settings object; null when the file does not exist yet, undefined when it cannot be read as JSON. */
export async function readSettings(io: Io): Promise<Record<string, unknown> | null | undefined> {
  const path = await settingsPath(io)
  if (!(await io.exists(path))) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(await io.readFile(path))

    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function writeSettings(io: Io, settings: Record<string, unknown>): Promise<void> {
  await io.writeFile(await settingsPath(io), `${JSON.stringify(settings, null, 2)}\n`)
}

async function settingsPath(io: Io): Promise<string> {
  return `${await io.home()}/.claude/settings.json`
}

/** Returns the settings with their `env` block changed, dropping the block once it is empty, every other key as it was. */
function withEnv(settings: Record<string, unknown>, change: (env: Record<string, unknown>) => void): Record<string, unknown> {
  const env: Record<string, unknown> = isObject(settings.env) ? { ...settings.env } : {}
  change(env)
  const result = { ...settings }
  if (Object.keys(env).length > 0) {
    result.env = env
  } else {
    delete result.env
  }

  return result
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

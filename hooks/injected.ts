import type { ApiContentBlock } from 'claude-code'

/** Claude Code's type of the message that carries the user's instruction files (CLAUDE.md and the like). */
export const INSTRUCTIONS = 'instructions'

/**
 * The name the copies of instruction files sent again mid-conversation are listed and ruled under, apart from the
 * `instructions` message a conversation starts with. Claude Code names its types in snake_case, so this can't clash.
 */
export const REREAD_INSTRUCTIONS = 'instructions:re-read'

/**
 * How Claude Code (2.1.325) opens an `instructions` message that carries only the files changed since the conversation got
 * them: on resume, after a working directory was added, after settings were synced, and so on. The hooks pass no flag for
 * it, so this wording is the only sign. A build that rewords it sends such copies as plain `instructions` again, which then
 * follow that type's rule: a rule meant for re-read copies alone never reaches the copy a conversation starts with.
 */
const REREAD_OPENINGS = ['Instruction files were re-read', 'These instruction files changed', 'Instructions no longer present:']

/** The name an injected message is listed, ruled and recorded under: its type, with re-read instruction copies kept apart. */
export function injectedName(type: string, text: string): string {
  return type === INSTRUCTIONS && REREAD_OPENINGS.some(opening => text.startsWith(opening)) ? REREAD_INSTRUCTIONS : type
}

const WRAP_START = '<system-reminder>\n'
const WRAP_END = '\n</system-reminder>'

/**
 * The text of a stored injected message as `prompt.attachment` hands it: the text blocks without the `<system-reminder>`
 * wrapper the transcript keeps around each, joined by newlines. Claude Code escapes a closing reminder tag inside the text
 * as it wraps it, so a text quoting one reads escaped here; nothing else differs.
 */
export function injectedText(content: readonly ApiContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text
      parts.push(text.startsWith(WRAP_START) && text.endsWith(WRAP_END) ? text.slice(WRAP_START.length, -WRAP_END.length) : text)
    }
  }

  return parts.join('\n')
}

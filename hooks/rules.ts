import type { PromptComposeSection } from 'claude-code'

import type { Action, AddedSection, Kind, Patch, Rule, Rules } from '../types'
import { INSTRUCTIONS, REREAD_INSTRUCTIONS } from './injected'

/** The id prefix of the user's own sections, as the engine wants a plugin's section ids. */
export const ADDED_PREFIX = 'prompt-tweaker:'

/** In a full replacement, stands for the engine's current text of the item. */
export const ORIGINAL_TOKEN = '{{original}}'

export function emptyRules(): Rules {
  return { version: 1, isPaused: false, sections: {}, added: [], context: {}, attachments: {}, tools: {} }
}

/** Reads rules.json leniently: a missing or damaged field falls back to empty, so one bad edit never stops every session. */
export function parseRules(text: string): Rules {
  const rules = emptyRules()
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw)) {
    return rules
  }
  rules.isPaused = raw.isPaused === true
  rules.sections = parseRuleMap(raw.sections)
  rules.context = parseRuleMap(raw.context)
  rules.attachments = parseRuleMap(raw.attachments)
  rules.tools = parseRuleMap(raw.tools)
  if (Array.isArray(raw.added)) {
    rules.added = raw.added.filter((one): one is AddedSection => isObject(one) && typeof one.id === 'string' && typeof one.text === 'string')
  }

  return rules
}

export function ruleMap(rules: Rules, kind: Kind): Record<string, Rule> {
  switch (kind) {
    case 'section':
      return rules.sections
    case 'context':
      return rules.context
    case 'attachment':
      return rules.attachments
    case 'tool':
      return rules.tools
  }
}

/** The item whose rule an item follows while it has none of its own: re-read instruction copies follow `instructions`. */
export function ruleParent(kind: Kind, name: string): string | undefined {
  return kind === 'attachment' && name === REREAD_INSTRUCTIONS ? INSTRUCTIONS : undefined
}

/** The rule an item follows: its own, else its parent's. */
export function ruleOf(rules: Rules, kind: Kind, name: string): Rule | undefined {
  return ruleMap(rules, kind)[name] ?? inheritedRule(rules, kind, name)?.rule
}

/** The parent's rule an item follows because it has none of its own; undefined when it has one, or nothing to follow. */
export function inheritedRule(rules: Rules, kind: Kind, name: string): { parent: string; rule: Rule } | undefined {
  const map = ruleMap(rules, kind)
  const parent = ruleParent(kind, name)
  if (parent === undefined || map[name] !== undefined) {
    return undefined
  }
  const rule = map[parent]

  return rule === undefined ? undefined : { parent, rule }
}

/** The tools the user removed from the session, none while the rules are paused; sorted, so two lists compare as text. */
export function removedTools(rules: Rules): string[] {
  return rules.isPaused ? [] : Object.keys(rules.tools).filter(name => rules.tools[name]?.mode === 'drop').sort()
}

/** The session's tools without the ones the user removed. */
export function keptTools<T extends { name: string }>(tools: readonly T[], rules: Rules): T[] {
  const removed = new Set(removedTools(rules))

  return tools.filter(tool => !removed.has(tool.name))
}

/** The rule in force for an item, none while the rules are paused. */
export function activeRule(rules: Rules, kind: Kind, name: string): Rule | undefined {
  return rules.isPaused ? undefined : ruleOf(rules, kind, name)
}

/** The text a rule sends in place of the engine's, or null for a dropped item. */
export function applyRule(text: string, rule: Rule | undefined): { text: string | null; action: Action } {
  if (rule === undefined) {
    return { text, action: 'sent' }
  }
  if (rule.mode === 'drop') {
    return { text: null, action: 'dropped' }
  }
  const result = rule.mode === 'replace' ? fillOriginal(rule.text, text) : applyPatches(text, rule.patches)

  return { text: result, action: result === text ? 'sent' : 'edited' }
}

/** A full replacement with every `{{original}}` filled in with the engine's current text. */
export function fillOriginal(replacement: string, original: string): string {
  return replacement.split(ORIGINAL_TOKEN).join(original)
}

/** Applies the pairs in order, each to the result of the one before; a pair with nothing to find does nothing. */
export function applyPatches(text: string, patches: readonly Patch[]): string {
  return patches.reduce((current, patch) => (patch.find === '' ? current : current.split(patch.find).join(patch.replace)), text)
}

/** How often a pair's text to find occurs in a text, as written: 0 means the pair no longer changes anything. */
export function countMatches(text: string, find: string): number {
  return find === '' ? 0 : text.split(find).length - 1
}

/**
 * Applies the section rules to a composed system prompt and appends the user's own sections.
 * A section keeps its cache side: every `shared` section must stay ahead of every `session` one, or the engine skips the hook.
 */
export function composeSections(sections: readonly PromptComposeSection[], rules: Rules): { sections: PromptComposeSection[]; actions: Map<string, Action> } {
  const actions = new Map<string, Action>()
  const result: PromptComposeSection[] = []
  for (const section of sections) {
    const applied = applyRule(section.text, activeRule(rules, 'section', section.id))
    actions.set(section.id, applied.action)
    if (applied.text !== null) {
      result.push(applied.text === section.text ? section : { ...section, text: applied.text })
    }
  }
  if (!rules.isPaused) {
    const taken = new Set(result.map(section => section.id))
    for (const added of rules.added) {
      const id = ADDED_PREFIX + added.id
      if (added.text.trim() !== '' && !taken.has(id)) {
        result.push({ id, text: added.text, scope: 'session' })
        taken.add(id)
      }
    }
  }

  return { sections: result, actions }
}

/** A fresh id for a new section of the user's own: `custom-1`, `custom-2`, ... */
export function nextAddedId(rules: Rules): string {
  const used = new Set(rules.added.map(one => one.id))
  let index = 1
  while (used.has(`custom-${index}`)) {
    index += 1
  }

  return `custom-${index}`
}

/** Returns new rules with `rule` set for the item, or removed when `rule` is undefined. */
export function withRule(rules: Rules, kind: Kind, name: string, rule: Rule | undefined): Rules {
  const map = { ...ruleMap(rules, kind) }
  if (rule === undefined) {
    delete map[name]
  } else {
    map[name] = rule
  }
  switch (kind) {
    case 'section':
      return { ...rules, sections: map }
    case 'context':
      return { ...rules, context: map }
    case 'attachment':
      return { ...rules, attachments: map }
    case 'tool':
      return { ...rules, tools: map }
  }
}

function parseRuleMap(value: unknown): Record<string, Rule> {
  const result: Record<string, Rule> = {}
  if (!isObject(value)) {
    return result
  }
  for (const [name, rule] of Object.entries(value)) {
    if (!isObject(rule)) {
      continue
    }
    if (rule.mode === 'drop') {
      result[name] = { mode: 'drop' }
    } else if (rule.mode === 'replace' && typeof rule.text === 'string') {
      result[name] = { mode: 'replace', text: rule.text }
    } else if (rule.mode === 'patch' && Array.isArray(rule.patches)) {
      const patches = rule.patches.filter((one): one is Patch => isObject(one) && typeof one.find === 'string' && typeof one.replace === 'string')
      if (patches.length > 0) {
        result[name] = { mode: 'patch', patches }
      }
    }
  }

  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

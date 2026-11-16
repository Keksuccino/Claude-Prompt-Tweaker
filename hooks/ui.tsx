import type { Elements, RenderElement } from 'claude-code'

/** The elements the panel draws with: the same on the terminal and the desktop app. */
export type Ui = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Input' | 'Code' | 'Select'>

/** A detail drawn beside a row's button: dim for facts, a theme color for a status. */
export type Detail = { text: string; tone: 'dim' | 'info' | 'error' | 'warning' | 'success' }

/**
 * One row of a list: the name is the button, and its details are drawn beside it, outside the button. The desktop app draws
 * a button's contents as plain text, so a color or dimming inside the button would be lost there.
 */
export function listRow(ui: Ui, row: { key: string; label: string; onPress: () => void; details: Detail[] }): RenderElement {
  const { Box, Button, Text } = ui

  return (
    <Box key={`row-${row.key}`} flexDirection="row" columnGap={1} alignItems="center">
      <Button key={row.key} label={row.label} plain onPress={row.onPress} />
      {row.details.map(detail => (detail.tone === 'dim' ? <Text dimColor>{detail.text}</Text> : <Text color={detail.tone === 'info' ? 'suggestion' : detail.tone}>{detail.text}</Text>))}
    </Box>
  )
}

/** Thousands with a comma, the one form every surface shows the same. */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatTime(at: number): string {
  if (at <= 0) {
    return 'unknown'
  }
  const date = new Date(at)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatClock(at: number): string {
  const date = new Date(at)

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

import { useTheme } from '../theme/ThemeProvider'

// Result-detail presentation only: stable identity, with independent dark accents.
const palettes = {
  light: ['#536E91', '#4F806F', '#79699E', '#9D5667', '#8A681F', '#7B7B88'],
  dark: ['#819CBC', '#73A394', '#AA9DCA', '#BC7988', '#B8955C', '#9898A6'],
} as const

export function useResultPalette() {
  const { resolvedTheme } = useTheme()
  return palettes[resolvedTheme === 'dark' ? 'dark' : 'light']
}

export function resultSeriesDash(index: number): number[] | undefined {
  return [undefined, [8, 3], [2, 3]][Math.floor(index / 6) % 3]
}

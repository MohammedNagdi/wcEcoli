import { createContext, useContext, useEffect, useState } from 'react'

export const WorkspaceWidthContext = createContext<number | null>(null)

export function useMediaQuery(query: string) {
  const width = useContext(WorkspaceWidthContext)
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  const range = query.match(/^\((min|max)-width:\s*(\d+)px\)$/)
  return width != null && range ? range[1] === "max" ? width <= Number(range[2]) : width >= Number(range[2]) : matches
}

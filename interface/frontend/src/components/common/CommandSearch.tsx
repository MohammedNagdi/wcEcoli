import { useState, useEffect, useRef, useCallback } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchGenes } from '../../api/client'
import type { Gene } from '../../types'
import { categoryLabel } from '../../utils/labels'

interface Props {
  open: boolean
  onClose: () => void
}

export function CommandSearch({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Gene[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      setLoading(true)
      searchGenes(query, 12)
        .then((genes) => {
          setResults(genes)
          setSelectedIndex(0)
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  const handleSelect = useCallback((gene: Gene) => {
    onClose()
    navigate(`/?gene=${encodeURIComponent(gene.symbol)}`)
  }, [navigate, onClose])

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedIndex((index) => Math.min(index + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && results[selectedIndex]) {
      event.preventDefault()
      handleSelect(results[selectedIndex])
    } else if (event.key === 'Escape') {
      onClose()
    }
  }

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 w-full max-w-lg z-50">
        <div className="bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
            <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search genes, proteins, or IDs..."
              className="flex-1 text-sm outline-none placeholder-gray-400"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono text-gray-400 bg-gray-100 border border-gray-200">
              ESC
            </kbd>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading && results.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Searching...</div>
            )}
            {!loading && query.length >= 2 && results.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">No results for "{query}"</div>
            )}
            {query.length < 2 && (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Type at least 2 characters...</div>
            )}
            {results.map((gene, index) => (
              <button
                key={gene.id}
                onClick={() => handleSelect(gene)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  index === selectedIndex ? 'bg-brand-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <span className="font-mono font-medium text-sm text-gray-900">{gene.symbol}</span>
                  {gene.is_mechanistic && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 ml-1.5 align-middle" />
                  )}
                  <span className="ml-2 text-xs text-gray-400">{categoryLabel(gene.category)}</span>
                </div>
                {gene.left_end_pos && (
                  <span className="text-xs text-gray-400 font-mono flex-shrink-0">
                    {gene.left_end_pos.toLocaleString()}
                  </span>
                )}
                <span className="text-xs text-gray-300 flex-shrink-0">enter</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 text-[10px] text-gray-400">
            <span>up/down navigate</span>
            <span>enter select</span>
            <span>esc close</span>
          </div>
        </div>
      </div>
    </>
  )
}

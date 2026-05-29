import { Link } from 'react-router-dom'
import type { GeneDetail } from '../../types'
import { CategoryBadge, DirectionBadge, RegTypeBadge } from '../common/Badge'
import { HelpTip } from '../common/HelpTip'

interface Props {
  gene: GeneDetail
  onClose: () => void
}

export function GeneDetailPanel({ gene, onClose }: Props) {
  const length = gene.left_end_pos && gene.right_end_pos
    ? Math.abs(gene.right_end_pos - gene.left_end_pos) + 1
    : null

  return (
    <div className="border-l border-gray-200 bg-white w-[420px] flex-shrink-0 overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 font-mono">{gene.symbol}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{gene.ecoli_id}</p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-1"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Quick facts */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Category</p>
            <CategoryBadge label={gene.category} />
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1 flex items-center gap-1">
              KO index
              <HelpTip text="The variant index used by wcEcoli to identify this gene in knockout experiments. Each gene has a unique index that maps to its position in the model's gene list." position="right" />
            </p>
            <span className="font-mono text-sm text-gray-700">{gene.ko_index}</span>
          </div>
          {gene.direction && (
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Strand</p>
              <DirectionBadge direction={gene.direction} />
            </div>
          )}
          {length && (
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Length</p>
              <span className="text-sm text-gray-700">{length.toLocaleString()} bp</span>
            </div>
          )}
        </div>

        {/* Genomic position */}
        {gene.left_end_pos && gene.right_end_pos && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Genomic position</p>
            <p className="text-sm font-mono text-gray-600">
              {gene.left_end_pos.toLocaleString()} – {gene.right_end_pos.toLocaleString()}
            </p>
          </div>
        )}

        {/* Synonyms */}
        {gene.synonyms && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Synonyms</p>
            <p className="text-sm text-gray-600">{gene.synonyms}</p>
          </div>
        )}

        {/* RNA IDs */}
        {gene.rna_ids && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">RNA product(s)</p>
            <div className="flex flex-wrap gap-1">
              {gene.rna_ids.split(',').map((id) => (
                <span key={id} className="px-1.5 py-0.5 bg-gray-50 text-gray-600 rounded text-xs font-mono border border-gray-100">
                  {id.trim()}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Regulated by */}
        {gene.regulated_by.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2 flex items-center gap-1">
              Regulated by ({gene.regulated_by.length})
              <HelpTip text="Transcription factors (TFs) that regulate this gene's expression in the model. The log2FC value indicates the fold-change effect: positive means activation, negative means repression. These regulatory relationships are mechanistically modeled — TF binding affects transcription initiation rates." position="right" />
            </p>
            <div className="space-y-1.5">
              {gene.regulated_by.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-bio-tf font-medium w-16">{r.tf}</span>
                  <RegTypeBadge type={r.type} />
                  <span className="text-gray-400 font-mono text-xs ml-auto">
                    {r.log2fc > 0 ? '+' : ''}{r.log2fc.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Regulates (if this gene is a TF) */}
        {gene.regulates.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">
              Regulates ({gene.regulates.length} targets)
            </p>
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {gene.regulates.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-bio-gene font-medium w-16">{r.target}</span>
                  <RegTypeBadge type={r.type} />
                  <span className="text-gray-400 font-mono text-xs ml-auto">
                    {r.log2fc > 0 ? '+' : ''}{r.log2fc.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Design knockout */}
        <div>
          <Link
            to={`/experiments/new?variant=gene_knockout&gene=${encodeURIComponent(gene.symbol)}`}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm
                       font-medium text-white bg-bio-gene hover:opacity-90 rounded-lg transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
            Design knockout experiment
          </Link>
        </div>

        {/* External links */}
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">External</p>
          <div className="flex gap-2">
            <a
              href={`https://ecocyc.org/gene?orgid=ECOLI&id=${gene.ecoli_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs bg-brand-50 text-brand-700 rounded-md hover:bg-brand-100 transition-colors"
            >
              EcoCyc
            </a>
            <a
              href={`https://www.uniprot.org/uniprot/?query=gene:${gene.symbol}+AND+organism_id:511145`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-xs bg-gray-50 text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
            >
              UniProt
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

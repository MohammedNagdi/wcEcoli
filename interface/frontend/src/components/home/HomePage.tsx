import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ThemeToggle } from '../theme/ThemeToggle'
import { useTheme } from '../theme/ThemeProvider'
import '../../styles/home.css'

const steps = [
  {
    title: 'Explore',
    description:
      'Find a gene and connect it to its products, genomic neighbourhood, and regulatory context.',
    link: '/explore',
    action: 'Explore the model',
  },
  {
    title: 'Simulate',
    description:
      'Choose a perturbation, configure the nutrient environment, and define your simulation parameters.',
    link: '/experiments/new',
    action: 'Design an experiment',
  },
  {
    title: 'Analyze',
    description:
      'Review completed runs, inspect biological outcomes, and compare experiments across conditions.',
    link: '/results',
    action: 'Browse results',
  },
]

const faqs = [
  {
    question: 'What does wcEcoli model?',
    answer:
      'wcEcoli is a whole-cell model of E. coli K-12 MG1655. The platform connects gene information, biological processes, experimental perturbations, and simulation outcomes. Model predictions should be interpreted in the context of the processes and assumptions represented.',
    link: '/guide',
    action: 'Understand the model',
  },
  {
    question: 'How do I start my first experiment?',
    answer:
      'Start with a wildtype control, choose a growth condition, and set the number of seeds and generations. The experiment designer explains each parameter. Save your configuration, then review it before running a simulation.',
    link: '/guide?section=variants',
    action: 'Read about experiment types',
  },
  {
    question: 'How should I interpret my results?',
    answer:
      'Compare your perturbation with a wildtype run under the same growth condition. Review the seed set, nutrient protocol, division behaviour, and growth measurements together. A knockout of a gene without a mechanistic connection may change its expression without changing growth.',
    link: '/guide?section=parameters',
    action: 'Review simulation parameters',
  },
  {
    question: 'Where can I find help?',
    answer:
      'The Guide covers experiment types, growth conditions, timelines, simulation parameters, and keyboard shortcuts. The Assistant can explain the platform and help inspect your current working context. Review proposed changes before confirming them.',
    link: '/guide?section=assistant',
    action: 'Learn about the Assistant',
  },
]

function Arrow() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 10h12m-5-5 5 5-5 5" />
    </svg>
  )
}

function ProductPreview({
  name,
  alt,
  priority = false,
}: {
  name: 'workspace' | 'experiment' | 'results'
  alt: string
  priority?: boolean
}) {
  const { resolvedTheme } = useTheme()
  const mode = resolvedTheme === 'dark' ? '-dark' : ''
  const height = { workspace: 960, experiment: 730, results: 835 }[name]
  return (
    <img
      src={`/previews/${name}${mode}.webp`}
      srcSet={`/previews/${name}${mode}-720.webp 720w, /previews/${name}${mode}.webp 1440w, /previews/${name}${mode}-2400.webp 2400w`}
      sizes={
        priority
          ? '(max-width: 380px) calc(100vw - 32px), (max-width: 1248px) calc(100vw - 48px), 1200px'
          : '(max-width: 380px) calc(100vw - 32px), (max-width: 800px) calc(100vw - 48px), (max-width: 1000px) calc((100vw - 80px) * 0.6364), (max-width: 1248px) calc((100vw - 112px) * 0.6364), 723px'
      }
      width={1200}
      height={height}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
    />
  )
}

export function HomePage() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [openFaq, setOpenFaq] = useState<number | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuPanel = useRef<HTMLDivElement>(null)
  const faqButtons = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (menuPanel.current) menuPanel.current.inert = !menuOpen
  }, [menuOpen])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 801px)')
    const close = () => setMenuOpen(false)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuOpen) {
        setMenuOpen(false)
        menuButton.current?.focus()
      }
    }
    media.addEventListener('change', close)
    window.addEventListener('keydown', escape)
    return () => {
      media.removeEventListener('change', close)
      window.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  return (
    <div className="home-page">
      <a className="home-skip" href="#main-content">
        Skip to content
      </a>
      <header className="home-header">
        <div className="home-container home-header-row">
          <Link to="/" className="home-wordmark" aria-label="wcEcoli home">
            <span className="home-mark" aria-hidden="true">
              wc
            </span>
            wcEcoli
          </Link>
          <nav className="home-desktop-nav" aria-label="Main navigation">
            <a href="#platform">Platform</a>
            <a href="#how-it-works">How it works</a>
            <Link to="/guide">Guide</Link>
          </nav>
          <div className="home-header-actions">
            <ThemeToggle compact />
            <Link className="home-button home-button-primary home-header-cta" to="/explore">
              Open workspace <Arrow />
            </Link>
            <button
              ref={menuButton}
              className="home-menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="home-mobile-menu"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                {menuOpen ? (
                  <path d="m5 5 10 10M5 15 15 5" />
                ) : (
                  <path d="M3 5h14M3 10h14M3 15h14" />
                )}
              </svg>
            </button>
          </div>
        </div>
        <div
          ref={menuPanel}
          id="home-mobile-menu"
          className={`home-mobile-menu ${menuOpen ? 'is-open' : ''}`}
          aria-hidden={!menuOpen}
        >
          <div>
            <nav
              className="home-container"
              aria-label="Mobile navigation"
              onClick={() => setMenuOpen(false)}
            >
              <a href="#platform">Platform</a>
              <a href="#how-it-works">How it works</a>
              <Link to="/guide">Guide</Link>
              <Link className="home-button home-button-primary" to="/explore">
                Open workspace <Arrow />
              </Link>
            </nav>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <section id="platform" className="home-container home-hero" aria-labelledby="hero-heading">
          <div className="home-hero-copy">
            <p className="home-eyebrow">
              <span className="home-status-dot" /> Whole-cell modelling · E. coli
            </p>
            <h1 id="hero-heading">
              Explore, simulate,
              <br className="home-heading-break" /> and understand E. coli.
            </h1>
            <div className="home-hero-bottom">
              <p>
                A whole-cell research platform for connecting biological context to computational
                experiments. Explore the model, test a hypothesis, and follow the results.
              </p>
              <div className="home-hero-actions">
                <Link className="home-button home-button-primary" to="/explore">
                  Open workspace <Arrow />
                </Link>
                <Link className="home-button home-button-secondary" to="/guide">
                  Read the guide
                </Link>
              </div>
            </div>
          </div>
          <figure className="home-product-frame home-hero-preview">
            <div className="home-preview-heading">
              <span>The gene workspace</span>
              <span className="home-preview-context">Example · dnaA</span>
            </div>
            <ProductPreview
              name="workspace"
              priority
              alt="wcEcoli gene workspace showing the gene catalog and dnaA's identifiers, chromosome position, knockout index, and genomic neighbourhood."
            />
            <figcaption>
              Start with a gene. See its biological context in one place.{' '}
              <Link to="/explore?gene=dnaA">
                Explore dnaA <Arrow />
              </Link>
            </figcaption>
          </figure>
          <p className="home-audience">
            For researchers, academics, and students working with whole-cell models.
          </p>
        </section>
        <section
          id="how-it-works"
          className="home-container home-section home-workflow"
          aria-labelledby="workflow-heading"
        >
          <div className="home-section-heading">
            <p className="home-eyebrow">From question to experiment</p>
            <h2 id="workflow-heading">A clear path through the model.</h2>
            <p>Three connected stages. Your existing tools, ready when you need them.</p>
          </div>
          <ol className="home-steps">
            {steps.map((step, index) => (
              <li key={step.title}>
                <span className="home-step-number">0{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
                <Link className="home-text-link" to={step.link}>
                  {step.action}
                  <Arrow />
                </Link>
              </li>
            ))}
          </ol>
        </section>
        <section
          className="home-container home-section home-showcase"
          aria-labelledby="simulate-heading"
        >
          <div className="home-showcase-copy">
            <p className="home-eyebrow">Simulate with context</p>
            <h2 id="simulate-heading">Turn a hypothesis into an experiment.</h2>
            <p>
              Choose a gene perturbation or an environmental change. Set the media protocol, seeds,
              and generations, then review the configuration before running.
            </p>
            <Link className="home-text-link" to="/experiments/new">
              Open the experiment designer <Arrow />
            </Link>
            <Link className="home-secondary-link" to="/guide?section=variants">
              New to simulation? Start with the guide.
            </Link>
          </div>
          <figure className="home-product-frame">
            <ProductPreview
              name="experiment"
              alt="wcEcoli experiment designer configured for a dnaA knockout, showing the selected gene, simulation parameters, and run summary."
            />
            <figcaption>
              Example configuration · dnaA gene knockout. No simulation is launched from this
              preview.
            </figcaption>
          </figure>
        </section>
        <section
          className="home-container home-section home-showcase home-showcase-reverse"
          aria-labelledby="analyze-heading"
        >
          <div className="home-showcase-copy">
            <p className="home-eyebrow">Analyze the outcomes</p>
            <h2 id="analyze-heading">Keep the result connected to the experiment.</h2>
            <p>
              Browse completed simulations by experiment and condition. Review growth, division, and
              mass together, and compare results across seed sets.
            </p>
            <Link className="home-text-link" to="/results">
              Browse experiment outcomes <Arrow />
            </Link>
            <Link className="home-secondary-link" to="/results/compare">
              Compare experiments
            </Link>
          </div>
          <figure className="home-product-frame">
            <ProductPreview
              name="results"
              alt="wcEcoli results browser showing completed example simulations with their media protocols, division times, final mass, growth, and doubling times."
            />
            <figcaption>
              Example simulation output from a local research session. These are model predictions.
            </figcaption>
          </figure>
        </section>
        <section className="home-container home-section home-help" aria-labelledby="help-heading">
          <div className="home-section-heading">
            <p className="home-eyebrow">A little orientation</p>
            <h2 id="help-heading">Get started with confidence.</h2>
            <p>Understand the model and the workflow before your first run.</p>
          </div>
          <div className="home-faqs">
            {faqs.map((faq, index) => (
              <div className="home-faq" key={faq.question}>
                <h3>
                  <button
                    ref={(node) => {
                      faqButtons.current[index] = node
                    }}
                    id={`faq-question-${index}`}
                    aria-expanded={openFaq === index}
                    aria-controls={`faq-answer-${index}`}
                    onClick={() => setOpenFaq(openFaq === index ? null : index)}
                    onKeyDown={(event) => {
                      let next: number | undefined
                      if (event.key === 'ArrowDown') next = (index + 1) % faqs.length
                      if (event.key === 'ArrowUp') next = (index + faqs.length - 1) % faqs.length
                      if (event.key === 'Home') next = 0
                      if (event.key === 'End') next = faqs.length - 1
                      if (next !== undefined) {
                        event.preventDefault()
                        faqButtons.current[next]?.focus()
                      }
                    }}
                  >
                    {faq.question}
                    <svg
                      aria-hidden="true"
                      className={openFaq === index ? 'is-open' : ''}
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <path d="m5 7 5 5 5-5" />
                    </svg>
                  </button>
                </h3>
                <div
                  id={`faq-answer-${index}`}
                  role="region"
                  aria-labelledby={`faq-question-${index}`}
                  aria-hidden={openFaq !== index}
                  ref={(node) => {
                    if (node) node.inert = openFaq !== index
                  }}
                  className={`home-faq-answer ${openFaq === index ? 'is-open' : ''}`}
                >
                  <div>
                    <p>{faq.answer}</p>
                    <Link className="home-text-link" to={faq.link}>
                      {faq.action}
                      <Arrow />
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="home-help-note">
            <p>
              Looking for a specific answer?
              <span>
                The Guide explains the tools. The Assistant helps with your working context.
              </span>
            </p>
            <Link className="home-text-link" to="/assistant">
              Ask the Assistant <Arrow />
            </Link>
          </div>
        </section>
        <section className="home-container home-closing" aria-labelledby="closing-heading">
          <div>
            <p className="home-eyebrow">Your next question starts here</p>
            <h2 id="closing-heading">Take a closer look at the cell.</h2>
          </div>
          <Link className="home-button home-button-primary" to="/explore">
            Open workspace <Arrow />
          </Link>
        </section>
      </main>
      <footer className="home-container home-footer">
        <Link className="home-wordmark" to="/" aria-label="wcEcoli home">
          <span className="home-mark" aria-hidden="true">
            wc
          </span>
          wcEcoli
        </Link>
        <p>E. coli K-12 MG1655</p>
        <nav aria-label="Footer navigation">
          <Link to="/guide">Guide</Link>
          <Link to="/assistant">Assistant</Link>
        </nav>
      </footer>
    </div>
  )
}

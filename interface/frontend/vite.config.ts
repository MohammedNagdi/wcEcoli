import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({mode}) => {
  const env = {...loadEnv(mode, process.cwd(), ''), ...process.env}
  const profile = env.VITE_DEPLOYMENT_MODE || 'local'
  if (!['local', 'explorer'].includes(profile)) throw new Error('Unknown deployment profile')
  if (profile === 'explorer' && env.VITE_PILOT_PREVIEW === '1') throw new Error('Conflicting explorer and pilot profiles')
  const entry = profile === 'explorer' ? 'explorer' : env.VITE_PILOT_PREVIEW === '1' ? 'pilot' : 'local'
  return {
  publicDir: profile === 'explorer' ? 'public-explorer' : 'public',
  plugins: [react(), {
    name: 'deployment-profile-boundary',
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap(item => item.type === 'chunk'
        ? Object.entries(item.modules).filter(([,info]) => info.renderedLength > 0).map(([id]) => id.replaceAll('\\', '/')) : [])
      const forbidden = profile === 'explorer'
        ? ['/src/App.tsx', '/src/PilotPreview.tsx', '/assistant/AssistantProvider.tsx', '/assistant/AssistantDock.tsx', '/deployment/persistence-local.ts']
        : entry === 'local' ? ['/explorer/drafts.ts', '/deployment/persistence-explorer.ts'] : []
      for (const suffix of forbidden) if (modules.some(id => id.endsWith(suffix)))
        throw new Error(`Profile ${entry} includes forbidden runtime module: ${suffix}`)
    },
  }],
  resolve: {
    alias: {
      '@deployment/drafts': path.resolve(__dirname, profile === 'explorer' ? './src/explorer/drafts.ts' : './src/deployment/drafts-local.ts'),
      '@deployment/assistant': path.resolve(__dirname, `./src/deployment/assistant-${profile}.tsx`),
      '@deployment/persistence': path.resolve(__dirname, `./src/deployment/persistence-${profile}.ts`),
      '@deployment/entry': path.resolve(__dirname, `./src/deployment/${entry}-entry.ts`),
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
}})

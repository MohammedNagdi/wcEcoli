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
  plugins: [react()],
  resolve: {
    alias: {
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

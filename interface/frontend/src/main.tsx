import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import PilotPreview from './PilotPreview'
import ExplorerApp from './explorer/ExplorerApp'
import {IS_EXPLORER} from './explorer/mode'
import { ThemeProvider } from './components/theme/ThemeProvider'
import './styles/globals.css'

// Data router enables navigation blocking for unsaved experiment edits.
const router = createBrowserRouter([{ path: '*', element: IS_EXPLORER ? <ExplorerApp/> : import.meta.env.VITE_PILOT_PREVIEW === '1' ? <PilotPreview /> : <App /> }])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </React.StrictMode>,
)

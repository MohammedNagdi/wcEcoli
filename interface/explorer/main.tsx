// Production entry: native execution and pilot applications are not imported.
import React from 'react'
import ReactDOM from 'react-dom/client'
import {createBrowserRouter, RouterProvider} from 'react-router-dom'
import ExplorerApp from './explorer/ExplorerApp'
import {ThemeProvider} from './components/theme/ThemeProvider'
import './styles/globals.css'

const router = createBrowserRouter([{path:'*', element:<ExplorerApp/>}])
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ThemeProvider><RouterProvider router={router}/></ThemeProvider></React.StrictMode>,
)

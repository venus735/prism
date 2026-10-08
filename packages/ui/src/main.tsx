import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { startFlowStream } from './stores/flows'
import { startBreakpointStream } from './stores/breakpoints'
import { startPluginLogStream } from './stores/plugins'
import { useThemeStore, watchSystemTheme } from './stores/theme'
import './index.css'

startFlowStream()
startBreakpointStream()
startPluginLogStream()
useThemeStore.getState().apply()
watchSystemTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

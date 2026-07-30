import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = createRoot(document.getElementById('root'))

function render(AppComponent) {
  root.render(createElement(AppComponent))
}

if (import.meta.env.VITE_APP_MODE === 'kiosk' || import.meta.env.MODE === 'kiosk') {
  import('./KioskStandaloneApp.jsx').then(({ default: KioskStandaloneApp }) => render(KioskStandaloneApp))
} else {
  import('./App.jsx').then(({ default: App }) => render(App))
}

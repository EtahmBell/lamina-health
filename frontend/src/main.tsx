import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { AuthProvider } from './AuthProvider.tsx'
import { SyntheticDeploymentBanner } from './SyntheticDeploymentBanner.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><AuthProvider><SyntheticDeploymentBanner /><App /></AuthProvider></StrictMode>,
)

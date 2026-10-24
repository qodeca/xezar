import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setApiBaseUrl } from '@qodeca/xezar-api-client'
import { resolveApiBase } from './api/api-base'
import { App } from './app'
import { installChunkReloadGuard } from './lib/chunk-reload'
import { requireRootContainer } from './root-container'
import './styles/index.css'

// Where the API lives – the run-time meta tag over the build-time value over same origin – set
// before anything can fetch. The precedence is documented and tested in `api/api-base.ts`.
setApiBaseUrl(resolveApiBase())

// A tab opened before an upgrade asks for code files the new build no longer has; reload it once.
installChunkReloadGuard()

createRoot(requireRootContainer()).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

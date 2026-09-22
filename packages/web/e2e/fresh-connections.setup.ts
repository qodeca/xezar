import { installFreshConnections } from './fresh-connections'

// Runs in every spec file's process before the spec: see `fresh-connections.ts` (#671).
installFreshConnections()

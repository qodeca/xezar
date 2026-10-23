import { Component, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { AlertTriangleIcon } from 'lucide-react'
import { isChunkLoadError } from '@/lib/chunk-reload'
import { CenteredState } from './centered-state'

import { Button } from './ui/button'

type Props = { children: ReactNode; locationKey: string }
/** `staleChunk`: the page's code file failed to load (a tab older than the running build). */
type State = { failed: boolean; staleChunk: boolean; locationKey: string }

class PageBoundary extends Component<Props, State> {
  override state: State = { failed: false, staleChunk: false, locationKey: this.props.locationKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, staleChunk: isChunkLoadError(error) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Navigation recovers a failed page without remounting healthy routes or the shell.
    return props.locationKey !== state.locationKey
      ? { failed: false, staleChunk: false, locationKey: props.locationKey }
      : null
  }

  /** `React.lazy` caches a failed import, so re-rendering a stale-chunk failure only repeats it;
   *  a fresh document reads the new build's file names. A user-initiated reload cannot loop, so it
   *  is not subject to the automatic reload's guard (`lib/chunk-reload.ts`). */
  private retry = () => {
    if (this.state.staleChunk) window.location.reload()
    else this.setState({ failed: false, staleChunk: false })
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="min-h-full">
        <CenteredState
          icon={<AlertTriangleIcon aria-hidden="true" />}
          tone="danger"
          title="Could not display this page"
          subtitle="Retry, or open another page from the sidebar."
          actions={<Button onClick={this.retry}>Retry</Button>}
        />
      </div>
    )
  }
}

/** Keep global subscriptions and navigation available when a routed child fails to render. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <PageBoundary locationKey={location.key}>{children}</PageBoundary>
}

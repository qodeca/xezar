import { Component, type ReactNode } from 'react'
import { useLocation } from 'react-router'

import { AlertTriangleIcon } from 'lucide-react'
import { CenteredState } from './centered-state'

import { Button } from './ui/button'

type Props = { children: ReactNode; locationKey: string }
type State = { failed: boolean; locationKey: string }

class PageBoundary extends Component<Props, State> {
  override state: State = { failed: false, locationKey: this.props.locationKey }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Navigation recovers a failed page without remounting healthy routes or the shell.
    return props.locationKey !== state.locationKey
      ? { failed: false, locationKey: props.locationKey }
      : null
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
          actions={<Button onClick={() => this.setState({ failed: false })}>Retry</Button>}
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

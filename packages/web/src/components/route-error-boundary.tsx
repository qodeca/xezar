import { Component, type ReactNode } from 'react'
import { useLocation } from 'react-router'

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
      <div role="alert" className="flex flex-col items-start gap-3 p-6">
        <h1 className="text-lg font-semibold">This page could not be displayed.</h1>
        <p className="text-sm text-muted-foreground">Try again, or open another page from the sidebar.</p>
        <Button onClick={() => this.setState({ failed: false })}>Try again</Button>
      </div>
    )
  }
}

/** Keep global subscriptions and navigation available when a routed child fails to render. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <PageBoundary locationKey={location.key}>{children}</PageBoundary>
}

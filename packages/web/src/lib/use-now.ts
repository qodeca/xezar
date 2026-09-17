import * as React from 'react'

/**
 * Re-render on a slow tick so relative ages stay true between data updates.
 *
 * 30s is the callers' interval: finer than the coarsest unit an age can show ('1m'), and cheap
 * enough that a screen of rows costs nothing between SSE updates. Shared by every surface that
 * prints an age, so no two of them disagree about what time it is.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

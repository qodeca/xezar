import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'

/**
 * One fresh TCP connection per spec-side `fetch` — the spec process never reuses a socket (#671).
 *
 * Why this exists. Every spec talks HTTP to a server in ANOTHER process — the shared dry-run
 * server or a spec-owned fixture server — and between two of its own requests it usually
 * blocks its whole event loop in a synchronous `execFileSync` of agent-browser (`AgentBrowser.run`)
 * for as long as the browser wait takes. Node's `fetch` pools sockets (keep-alive), and the
 * server closes an idle one after its 5 s keep-alive window. When the block outlasts that window,
 * whether the next `fetch` goes out on a fresh socket or on the one the server already closed is
 * decided by undici's idle-socket check racing the server's FIN — a timing question, not a
 * property of the test. undici 7.29.1 (bundled in Node 24.21.0) moved that check from a
 * `setTimeout(0)` to a `setImmediate`; from the first CI runner on 24.21.0 the race was lost
 * often enough to fail 7–15 files a run with `fetch failed` → `other side closed`
 * (`UND_ERR_SOCKET`), and a failed restore in one spec's `afterAll` then bled into later specs.
 *
 * `pipelining: 0` is undici's documented "disable keep-alive": every request carries
 * `connection: close`, and the socket is destroyed after its response. A socket therefore never
 * sits idle between two requests, so there is nothing for the server's keep-alive timer to close
 * under a later request — however long the event loop was blocked, and on any undici version.
 *
 * Returns the dispatcher it replaced, so a caller that must restore the process (the unit test)
 * can.
 */
export function installFreshConnections(): Dispatcher {
  const previous = getGlobalDispatcher()
  setGlobalDispatcher(new Agent({ pipelining: 0 }))
  return previous
}

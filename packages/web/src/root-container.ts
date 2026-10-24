/**
 * The element the cockpit mounts into. A missing `#root` means `index.html` and the bundle no
 * longer agree, so fail loudly at boot rather than render nothing.
 */
export function requireRootContainer(doc: Document = document): HTMLElement {
  const container = doc.getElementById('root')
  if (!container) throw new Error('xezar: #root container is missing from index.html')
  return container
}

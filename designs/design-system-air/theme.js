// Air mockup – view state for every page in this folder. Loaded in <head>, so <html> carries every
// axis before first paint. resolve(key) reads URL → storage (persisted keys, top level only) →
// default through one frozen table; every write uses the checked value. A frame (self !== top)
// gets .framed, reads the URL only and never writes storage.
(function () {
  'use strict'
  var root = document.documentElement
  var framed = window.self !== window.top
  var flags = { url: false, storage: false }
  var params = new URLSearchParams(location.search)

  // The five screen pages and what compare.html may ask of each; membership is Map/Set .has.
  function page(file, name, states, sections, anchors) {
    return Object.freeze({ file: file, name: name, states: new Map(states), sections: new Map(sections), at: new Set(anchors) })
  }
  var PAGES = Object.freeze({
    tasks: page('tasks.html', 'Tasks', [], [], []),
    thread: page('thread.html', 'Thread', [['loading', 'Loading'], ['dialog', 'Dialog']], [], ['speaker-2', 'ask-card', 'dock']),
    changes: page('changes.html', 'Changes', [], [], []),
    settings: page('settings.html', 'Settings', [['error', 'Field error (Agents)']],
      [['agents', 'Agents'], ['appearance', 'Appearance'], ['accounts', 'Agent accounts']], []),
    inbox: page('inbox.html', 'Inbox', [['empty', 'Empty'], ['error', 'Page error']], [], []),
  })
  var SCREENS = Object.freeze(Object.keys(PAGES))
  var FILE = location.pathname.split('/').pop() || 'index.html'
  var PAGE = SCREENS.filter(function (key) { return PAGES[key].file === FILE })[0] || ''

  // key → [value, label] options, default, storage key (persisted axes only), pages (null = all).
  function axis(options, def, store, pages) {
    return Object.freeze({ options: options && Object.freeze(options), def: def, store: store, pages: pages })
  }
  var AXES = Object.freeze({
    theme: axis([['dark', 'Dark'], ['light', 'Light']], 'dark', 'air-mock-theme', null),
    accent: axis([['lime', 'Lime'], ['violet', 'Violet']], 'lime', 'air-mock-accent', null),
    density: axis([['roomy', 'Roomy (proposed)'], ['comfortable', 'Comfortable'], ['compact', 'Compact'],
      ['ultra', 'Compact for real']], 'comfortable', 'air-mock-density', null),
    width: axis([['narrow', 'Narrow'], ['wide', 'Wide']], 'narrow', 'air-mock-width', null),
    v: axis([['today', 'Today'], ['air', 'Proposed']], 'air', 'air-mock-view', SCREENS),
    table: axis([['a', 'A – keeps the section gutter'], ['b', 'B – exempt, today’s 20 px']], 'a', null, ['tasks']),
    cta: axis([['a', 'A – 40 px'], ['b', 'B – 36 px']], 'a', null, ['tasks']),
    drawer: axis([['', 'Closed'], ['open', 'Open']], '', null, ['tasks']),
    state: axis(null, '', null, ['thread', 'inbox', 'settings']),
    section: axis(null, 'agents', null, ['settings']),
  })
  var PERSISTED = Object.freeze(['theme', 'accent', 'density', 'width', 'v'])
  var PAGE_KEYS = Object.freeze(['table', 'cta', 'drawer', 'state', 'section'])
  var OPEN = Object.freeze({ table: 'point 6', cta: 'point 7' }) // the two open points, named for a caption

  // The options a page allows for key, or null when the key does not apply there. compare.html asks
  // on behalf of the page it frames, so the page is a parameter and defaults to this one.
  function options(key, page) {
    if (page === undefined) page = PAGE
    if (!Object.hasOwn(AXES, key)) return null
    var entry = AXES[key]
    if (entry.pages && entry.pages.indexOf(page) === -1) return null
    if (key === 'state') return [['', 'Default']].concat(Array.from(PAGES[page].states))
    if (key === 'section') return Array.from(PAGES[page].sections)
    return entry.options
  }
  function allows(key, value, page) {
    var list = options(key, page)
    return Boolean(list) && list.some(function (option) { return option[0] === value })
  }
  function stored(storeKey) {
    try { return localStorage.getItem(storeKey) } catch (e) { flags.storage = true; return null }
  }
  function resolve(key) {
    if (!options(key)) return undefined
    var asked = params.get(key)
    if (asked !== null && allows(key, asked)) return asked
    var kept = AXES[key].store && !framed ? stored(AXES[key].store) : null
    return kept !== null && allows(key, kept) ? kept : AXES[key].def
  }

  var state = {}
  Object.keys(AXES).forEach(function (key) {
    var value = resolve(key)
    if (value !== undefined) state[key] = value
  })

  function data(name, value) {
    if (value) root.setAttribute('data-' + name, value)
    else root.removeAttribute('data-' + name)
  }
  // .light, data-accent, data-density (absent at Comfortable) and data-width as cockpit.css reads
  // them (:139-192), plus the mockup's view and page keys.
  function stamp() {
    root.classList.toggle('light', state.theme === 'light')
    root.classList.toggle('framed', framed)
    data('accent', state.accent)
    data('density', state.density === 'comfortable' ? '' : state.density)
    data('width', state.width === 'wide' ? 'wide' : '')
    data('view', state.v)
    PAGE_KEYS.forEach(function (key) { data(key, state[key]) })
  }
  stamp()

  // Top level only: storage first, then the address bar, each in its own try (L9).
  function remember(key, value) {
    var store = AXES[key].store
    if (store) { try { localStorage.setItem(store, value) } catch (e) { flags.storage = true } }
    try {
      var url = new URL(location.href)
      // A persisted axis stays in the address even at its default, so a cited URL renders the view
      // its author saw and never reads the reader's storage (M9). A page key's default is no key.
      PERSISTED.forEach(function (name) { if (Object.hasOwn(state, name)) url.searchParams.set(name, state[name]) })
      if (value === AXES[key].def && !store) url.searchParams.delete(key)
      else url.searchParams.set(key, value)
      history.replaceState(history.state, '', url.href)
    } catch (e) {
      flags.url = true // a page opened from disk may refuse a changed query; bar.js says so once
    }
  }
  function set(key, value) {
    if (!Object.hasOwn(state, key) || !allows(key, value) || state[key] === value) return false
    state[key] = value
    stamp()
    if (!framed) remember(key, value)
    sync()
    document.dispatchEvent(new CustomEvent('air:change', { detail: { key: key } }))
    return true
  }

  // Persisted axes off their default travel on frames and same-folder links, unless the authored
  // URL already states the key: authored keys are pinned, and page keys never travel.
  function carry(url) {
    PERSISTED.forEach(function (key) {
      if (!Object.hasOwn(state, key) || state[key] === AXES[key].def || url.searchParams.has(key)) return
      url.searchParams.set(key, state[key])
    })
    return url
  }
  function compareHref(target) {
    if (!Object.hasOwn(PAGES, target)) return null
    var url = new URL('compare.html', location.href)
    url.searchParams.set('page', target)
    // Both open points travel, or "Compare at 1280" frames option A whatever the bar says (M10).
    if (target === PAGE) ['section', 'state'].concat(Object.keys(OPEN)).forEach(function (key) {
      if (state[key]) url.searchParams.set(key, state[key])
    })
    return 'compare.html' + url.search
  }

  var SAME_FOLDER = /^[a-z0-9][a-z0-9-]*\.html(?=[?#]|$)/i
  var STATUS = Object.freeze({ today: 'Showing the today view – the page above draws each row’s Today value.',
    air: 'Showing the proposed view – the page above draws each row’s Proposed value.' })
  var authored = new WeakMap()
  var title = null

  // Frames, same-folder links, the title, view-only fieldsets and the values status. Each link is
  // rebuilt from the href it was authored with, so a key added earlier never looks authored.
  function sync() {
    if (title === null) title = document.title
    document.querySelectorAll('iframe[data-src]').forEach(function (frame) {
      var url = carry(new URL(frame.getAttribute('data-src'), location.href))
      if (frame.src !== url.href) frame.src = url.href
      // Screenshot evidence (L14): a tail span names the axes this frame's URL holds off default.
      var node = frame.closest('figure') && frame.closest('figure').querySelector('.air-caption')
      if (!node) return
      var tail = node.querySelector('.air-axes') || node.appendChild(document.createElement('span'))
      tail.className = 'air-axes'
      tail.textContent = ['theme', 'accent', 'density', 'width'].map(function (key) {
        var asked = url.searchParams.get(key)
        return allows(key, asked) && asked !== AXES[key].def ? ' · ' + asked : ''
      }).join('')
    })
    document.querySelectorAll('a[href]').forEach(function (link) {
      if (!authored.has(link)) authored.set(link, link.getAttribute('href'))
      var target = link.getAttribute('data-air-compare')
      var href = target === null ? authored.get(link) : compareHref(target)
      var file = href ? SAME_FOLDER.exec(href) : null
      if (!file) return
      var url = carry(new URL(href, location.href))
      var next = file[0] + url.search + url.hash
      if (link.getAttribute('href') !== next) link.setAttribute('href', next)
    })
    document.querySelectorAll('fieldset[data-view-only]').forEach(function (group) {
      group.disabled = Object.hasOwn(state, 'v') && state.v !== group.getAttribute('data-view-only')
    })
    if (!Object.hasOwn(state, 'v')) return
    document.title = title + (state.v === 'today' ? ' – today' : ' – proposed')
    var status = document.querySelector('.air-values-status')
    if (status) status.textContent = STATUS[state.v]
  }

  // compare.html (<body data-compare>): two frames of one screen page, Today and Proposed.
  function buildCompare() {
    if (!document.body || !document.body.hasAttribute('data-compare')) return
    var key = params.get('page')
    if (key === null || !Object.hasOwn(PAGES, key)) key = 'tasks'
    var target = PAGES[key]
    var section = params.get('section'), asked = params.get('state'), at = params.get('at')
    var label = [target.name, target.sections.get(section), target.states.get(asked)].filter(Boolean).join(' · ')
    // An open point travels into the page that offers it, and the proposed caption names it (M10).
    var open = Object.keys(OPEN).filter(function (name) { return options(name, key) !== null })
      .map(function (name) { return [name, allows(name, params.get(name), key) ? params.get(name) : AXES[name].def] })
    var shown = open.map(function (pair) { return OPEN[pair[0]] + ' option ' + pair[1].toUpperCase() })
    document.querySelectorAll('iframe[data-compare-view]').forEach(function (frame) {
      var today = frame.getAttribute('data-compare-view') === 'today'
      var url = new URL(target.file, location.href)
      if (target.sections.has(section)) url.searchParams.set('section', section)
      if (target.states.has(asked)) url.searchParams.set('state', asked)
      open.forEach(function (pair) { url.searchParams.set(pair[0], pair[1]) })
      url.searchParams.set('v', today ? 'today' : 'air')
      if (target.at.has(at)) url.hash = at
      var full = [label].concat(today ? [] : shown).join(' · ') // an option applies to proposed only
      frame.setAttribute('data-src', url.href)
      frame.title = full + ' – ' + (today ? 'Today' : 'Proposed') + ' – 1:1'
      var caption = frame.closest('figure') ? frame.closest('figure').querySelector('.air-caption') : null
      if (caption) caption.textContent = (today ? 'Today' : 'Proposed') + ' · ' + full + ' · 1:1'
    })
  }

  document.addEventListener('DOMContentLoaded', function () { buildCompare(); sync() })

  window.AIR = Object.freeze({
    framed: framed, page: PAGE, screen: PAGE !== '', options: options, set: set, sync: sync,
    get: function (key) { return Object.hasOwn(state, key) ? state[key] : undefined },
    flags: function () { return { url: flags.url, storage: flags.storage } },
  })
})()

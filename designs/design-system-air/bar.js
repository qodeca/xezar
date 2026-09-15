// Air mockup – the review bar. Built with createElement and textContent from AIR's axis table
// (theme.js), never from markup strings. The script tag says what the bar carries:
//   data-controls="view theme accent density width"  the Show radios and the axis selects
//   data-states="…", data-sections="…"                State and Section selects (AIR checks each value)
//   data-open-points                                  open points 6 and 7 (tasks.html)
//   data-compare="<page>"                             the "Compare at 1280" link
// The header goes in before this tag. Its measured height lands on <html> as --air-bar-measured
// (styles.css owns --air-bar-h), and the page's own sticky head's as --air-head-measured
// (chrome.css owns --air-head-h).
(function () {
  'use strict'
  var AIR = window.AIR
  var tag = document.currentScript
  if (!AIR || !tag || AIR.framed) return

  var PREFIX = 'air-'
  var NAV = [
    ['index.html', 'Start'], ['tasks.html', 'Tasks'], ['thread.html', 'Thread'], ['changes.html', 'Changes'],
    ['settings.html', 'Settings'], ['inbox.html', 'Inbox'], ['compare.html', 'Compare'], ['phone.html', '375 px'],
    ['states.html', 'States'], ['appearance.html', 'Appearance axes'], ['README.md', 'README'],
  ]
  var SELECTS = [['theme', 'Theme'], ['accent', 'Accent'], ['density', 'Density'], ['width', 'Width']]
  var here = location.pathname.split('/').pop() || 'index.html'

  function words(value) {
    return (value || '').split(/\s+/).filter(Boolean)
  }

  function el(name, attrs, text) {
    var node = document.createElement(name)
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]) })
    if (text) node.textContent = text
    return node
  }

  // Native radios: ←/→ on the focused one moves the choice and fires change.
  function radios(key, legend, viewOnly) {
    var group = el('fieldset', viewOnly ? { 'data-view-only': viewOnly } : {})
    group.append(el('legend', {}, legend))
    AIR.options(key).forEach(function (option) {
      var id = PREFIX + key + '-' + option[0]
      var input = el('input', { class: 'sr-only', type: 'radio', name: PREFIX + key, id: id, value: option[0] })
      input.addEventListener('change', function () {
        if (input.checked) AIR.set(key, option[0])
      })
      group.append(input, el('label', { for: id }, option[1]))
    })
    return group
  }

  function select(key, label, only) {
    var wrap = el('label', { class: 'air-select' }, label + ' ')
    var box = el('select', { name: PREFIX + key })
    AIR.options(key).forEach(function (option) {
      if (only.length && option[0] !== '' && only.indexOf(option[0]) === -1) return
      box.append(el('option', { value: option[0] }, option[1]))
    })
    box.addEventListener('change', function () { AIR.set(key, box.value) })
    wrap.append(box)
    return wrap
  }

  var header = el('header', { class: 'doc-bar air-bar' })
  var nav = el('nav', { 'aria-label': 'Proposal pages' })
  NAV.forEach(function (item) {
    var link = el('a', { href: item[0] }, item[1])
    if (item[0] === here) link.setAttribute('aria-current', 'page')
    nav.append(link)
  })

  var form = el('form', { class: 'air-view', 'aria-label': 'View' })
  form.addEventListener('submit', function (event) { event.preventDefault() })
  var controls = words(tag.getAttribute('data-controls'))
  if (controls.indexOf('view') !== -1 && AIR.options('v')) form.append(radios('v', 'Show'))
  SELECTS.forEach(function (pair) {
    if (controls.indexOf(pair[0]) !== -1) form.append(select(pair[0], pair[1], []))
  })
  if (tag.hasAttribute('data-sections') && AIR.options('section')) {
    form.append(select('section', 'Section', words(tag.getAttribute('data-sections'))))
  }
  if (tag.hasAttribute('data-states') && AIR.options('state')) {
    form.append(select('state', 'State', words(tag.getAttribute('data-states'))))
  }
  if (tag.hasAttribute('data-open-points') && AIR.options('table')) {
    form.append(radios('table', 'Open point 6 – task-table wrapper', 'air'))
    form.append(radios('cta', 'Open point 7 – New-task button', 'air'))
    // Shown in both views, so the bar keeps one height and the flip never moves the page.
    form.append(el('p', { class: 'air-op-note' }, 'Options A and B apply to the proposed view'))
  }
  var compare = tag.getAttribute('data-compare')
  if (compare) form.append(el('a', { href: 'compare.html', 'data-air-compare': compare }, 'Compare at 1280'))
  var status = el('p', { class: 'air-status', role: 'status' })
  var note = el('p', { class: 'air-note' })
  form.append(status, note)
  header.append(nav, form)
  tag.before(header)

  // Controls, the live status (the view word only) and the note line (not live).
  function update() {
    form.querySelectorAll('input[type="radio"]').forEach(function (input) {
      input.checked = AIR.get(input.name.slice(PREFIX.length)) === input.value
    })
    form.querySelectorAll('select').forEach(function (box) {
      box.value = AIR.get(box.name.slice(PREFIX.length))
    })
    var view = AIR.screen ? (AIR.get('v') === 'today' ? 'Showing today' : 'Showing proposed') : ''
    if (status.textContent !== view) status.textContent = view
    var lines = []
    if (AIR.screen && AIR.get('v') === 'today' && AIR.get('density') === 'roomy') {
      lines.push('Roomy does not exist today – this today view is hypothetical')
    }
    var width = window.innerWidth
    if ((AIR.screen || document.body.hasAttribute('data-compare')) && width !== 1280 && width !== 375) {
      lines.push('Window ' + width + ' px – values assume 1280 or 375')
    }
    var flags = AIR.flags()
    if (flags.url) lines.push('Address bar not updated – opened from disk')
    if (flags.storage) lines.push('Choices not remembered – browser storage unavailable')
    note.textContent = lines.join(' · ')
  }

  // Two measured heights, one writer: the review bar, and the page's own sticky head under it – the
  // .page-head on Tasks, Settings and Inbox, the .air-run-head on Thread and Changes. Selected by
  // class, so no page's markup changes. Either reads 0 when the page has none or the state hides it,
  // and both stay unset inside a frame, where this script returns before it builds anything.
  var HEAD = '.air-screen .page-head, .air-screen .air-run-head'
  var head = null
  var sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null

  function measure() {
    var style = document.documentElement.style
    style.setProperty('--air-bar-measured', header.offsetHeight + 'px')
    style.setProperty('--air-head-measured', (head ? head.offsetHeight : 0) + 'px')
  }

  // This tag comes before the shell, so the head is not in the DOM yet; it is found once it is.
  function watchHead() {
    head = document.querySelector(HEAD)
    if (head && sizes) sizes.observe(head)
    measure()
  }

  if (sizes) sizes.observe(header)
  measure()
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchHead)
  else watchHead()
  update()
  document.addEventListener('air:change', update)
  window.addEventListener('resize', update)
})()

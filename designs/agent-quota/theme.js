// Mockup-only behaviour: the theme switch and the limits chip's popover. Dark is the cockpit
// default; `.light` on <html> flips the tokens. Same shape as designs/agent-accounts-onboarding/theme.js,
// with its own storage key. Never shipped.
(function () {
  var root = document.documentElement
  // Inside a phone preview iframe the design-doc bar is noise – hide it.
  if (window.self !== window.top) root.classList.add('framed')
  try {
    if (localStorage.getItem('aq-mock-theme') === 'light') root.classList.add('light')
  } catch (e) {}
  // `?theme=light` wins, so a capture can pin a theme without a click.
  if (/[?&]theme=light\b/.test(location.search)) root.classList.add('light')
  if (/[?&]theme=dark\b/.test(location.search)) root.classList.remove('light')

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-theme-toggle]')
    if (button) {
      var light = root.classList.toggle('light')
      try {
        localStorage.setItem('aq-mock-theme', light ? 'light' : 'dark')
      } catch (e) {}
      document.querySelectorAll('iframe').forEach(function (frame) {
        try {
          frame.contentDocument.documentElement.classList.toggle('light', light)
        } catch (e) {}
      })
      return
    }
    // The chip is a real button that opens and closes its popover, so the keyboard path
    // (Tab to it, Enter or Space, Escape back) can be walked in the mockup.
    var chip = event.target.closest('[data-pop-toggle]')
    if (chip) {
      var pop = document.getElementById(chip.getAttribute('aria-controls'))
      if (!pop) return
      var open = chip.getAttribute('aria-expanded') !== 'true'
      chip.setAttribute('aria-expanded', open ? 'true' : 'false')
      pop.hidden = !open
      if (open) {
        var first = pop.querySelector('a, button')
        if (first) first.focus()
      }
    }
  })

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    document.querySelectorAll('[data-pop-toggle][aria-expanded="true"]').forEach(function (chip) {
      var pop = document.getElementById(chip.getAttribute('aria-controls'))
      if (pop) pop.hidden = true
      chip.setAttribute('aria-expanded', 'false')
      chip.focus()
    })
  })
})()

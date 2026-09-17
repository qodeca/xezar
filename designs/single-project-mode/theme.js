// Mockup-only theme switch. Dark is the cockpit default; `.light` on <html> flips the tokens.
// Same shape as designs/onboarding/theme.js, with its own storage key.
(function () {
  var root = document.documentElement
  // Inside a phone preview iframe the design-doc bar is noise – hide it.
  if (window.self !== window.top) root.classList.add('framed')
  try {
    if (localStorage.getItem('spm-mock-theme') === 'light') root.classList.add('light')
  } catch (e) {}
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-theme-toggle]')
    if (!button) return
    var light = root.classList.toggle('light')
    try {
      localStorage.setItem('spm-mock-theme', light ? 'light' : 'dark')
    } catch (e) {}
    document.querySelectorAll('iframe').forEach(function (frame) {
      try {
        frame.contentDocument.documentElement.classList.toggle('light', light)
      } catch (e) {}
    })
  })
})()

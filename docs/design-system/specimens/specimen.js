// Specimen-only controls. Dark is the cockpit default; `.light` on <html> flips the tokens.
// Accent, density and width are stamped as `data-*` attributes exactly as the cockpit's pre-paint
// script does (packages/web/index.html). Defaults are the ABSENCE of the attribute.
(function () {
  var root = document.documentElement
  if (window.self !== window.top) root.classList.add('framed')

  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (e) {}
  }

  function apply() {
    root.classList.toggle('light', read('ds-theme') === 'light')
    var accent = read('ds-accent')
    if (accent === 'violet') root.dataset.accent = 'violet'
    else delete root.dataset.accent
    var density = read('ds-density')
    if (density === 'roomy' || density === 'compact' || density === 'ultra') root.dataset.density = density
    else delete root.dataset.density
    if (read('ds-width') === 'wide') root.dataset.width = 'wide'
    else delete root.dataset.width
    document.querySelectorAll('select[data-appearance]').forEach(function (select) {
      var key = 'ds-' + select.dataset.appearance
      var value = read(key)
      select.value = value || select.options[0].value
    })
  }

  apply()
  document.addEventListener('DOMContentLoaded', apply)

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-theme-toggle]')
    if (!button) return
    write('ds-theme', root.classList.contains('light') ? 'dark' : 'light')
    apply()
  })

  document.addEventListener('change', function (event) {
    var select = event.target.closest('select[data-appearance]')
    if (!select) return
    write('ds-' + select.dataset.appearance, select.value)
    apply()
  })
})()

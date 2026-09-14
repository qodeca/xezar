// Mockup-only theme and density switches for the air examples.
(function () {
  var root = document.documentElement
  try {
    if (localStorage.getItem('air-mock-theme') === 'light') root.classList.add('light')
    var d = localStorage.getItem('air-mock-density')
    if (d && d !== 'comfortable') root.dataset.density = d
  } catch (e) {}
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-theme-toggle]')
    if (!button) return
    var light = root.classList.toggle('light')
    try { localStorage.setItem('air-mock-theme', light ? 'light' : 'dark') } catch (e) {}
  })
  document.addEventListener('DOMContentLoaded', function () {
    var select = document.querySelector('[data-density-select]')
    if (!select) return
    select.value = root.dataset.density || 'comfortable'
    select.addEventListener('change', function () {
      if (select.value === 'comfortable') delete root.dataset.density
      else root.dataset.density = select.value
      try { localStorage.setItem('air-mock-density', select.value) } catch (e) {}
    })
  })
})()

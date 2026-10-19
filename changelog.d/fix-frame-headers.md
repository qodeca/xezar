## 🔒 Security

- 🔒 **The cockpit refuses to be shown inside a frame on another site.** Every HTML page the
  service sends – the cockpit itself and the built-in recovery page – now carries
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. Nothing else in
  the page policy changes, API answers are untouched, and a hosted cockpit behind a reverse proxy
  works as before.

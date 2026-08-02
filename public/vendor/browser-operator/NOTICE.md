# Vendored from Browser Operator (BSD-3-Clause)

These stylesheets are copied **verbatim**, headers intact, from
[BrowserOperator/browser-operator-core](https://github.com/BrowserOperator/browser-operator-core):

| file | source |
|---|---|
| `design_system_tokens.css` | `front_end/design_system_tokens.css` |
| `application_tokens.css` | `front_end/application_tokens.css` (237 tokens, light + dark) |
| `chatView.css` | `front_end/panels/ai_chat/ui/chatView.css` (3164 lines) |

Copyright 2025 The Chromium Authors. Licensed BSD-3-Clause — see the repository's LICENSE.
Nothing here is modified; `operator.html` reuses the same class names so the styling resolves
exactly as it does in the desktop app.

## `_compat.css` is ours, not theirs

The fork inherits part of its token layer from upstream DevTools at runtime, so 31 tokens it
uses are defined nowhere in the repository. Served standalone they fell back to the browser
default — a "running" status dot rendered black instead of muted grey. `_compat.css` maps each
one onto the reference palette that *is* vendored, using the same convention as the vendored
files. Their CSS is untouched; the shim is kept separate so the line stays obvious.

Verified after the shim: completed `rgb(30 164 70)`, running `rgb(68 71 70)`, error
`rgb(179 38 30)`, panel surface `rgb(253 252 251)` — and zero unresolved tokens.

# Reference: the real ego (lite) interface

The UI in `public/index.html` is rebuilt from these, not from memory. They are the official
screenshots published by citrolabs at `cdn.ego.app/assets/docs`.

* `ego-lite-browser.png` — dark Chromium chrome: macOS traffic lights, pill tab with favicon,
  `+` for a new tab, round address bar with a site-info glyph, and the **grid button in the
  top-right corner** that opens Spaces.
* `ego-lite-spaces.png` — the white Space sheet: `N space(s)` centred, an agent-count pill
  top-right, a grid of live space previews with the space name on the left and the agent on
  the right, a ring around the space an agent is driving, and a `+` tile to add one. The
  Expedia preview also shows the agent control bar: task, **Agent is in control**, *Take over*,
  *Stop*.

The browser UI itself is not open source — the ego-lite repo (150 files) ships the Node helper
runtime, docs and skills only; the Chromium fork is distributed as a macOS `.dmg`. These
screenshots are therefore the authoritative reference for the look.

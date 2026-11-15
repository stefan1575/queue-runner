# 44: The Inbox's actions on the row, as icons on hover

**What to build:** Mark unread and Snooze move from the briefing onto the Inbox row, as icons
that appear when the row is hovered, as in T3's sidebar. Unsnooze becomes an icon the same way.
The briefing loses its buttons.

**Blocked by:** 36 (it is changing read and snoozed in the same code of `dashboard/index.html`)

**Status:** done (2026-11-16)

Raised by Stefan on 2026-11-15, on the Inbox: "the snooze button lives inside the card where the
item exists... not entirely the full text, but rather the logo only... the clock doesn't normally
show, only on hover... When I hover the clock, that's when a tooltip appears... The unsnooze
button, I dislike it... a logo, just like in T3." And on the briefing: "you can just remove those
two buttons on top."

## Decided (mine, Stefan's to overturn)

- **A waiting row**, on hover: two icons at its right, over the age. Mark unread or read
  (an envelope) and Snooze (the clock). They are hidden otherwise.
- **Hovering an icon** shows its tooltip: "Mark unread", "Mark read", "Snooze".
- **The clock opens the snooze menu** with the same choices (`snoozeChoices()`), anchored to
  the row. The row's icons stay up while its menu is open.
- **A snoozed row**, on hover: one icon, Unsnooze (the clock struck through), with its
  tooltip. The text button goes.
- **A decided row** gets no icons. An answered ask can't be snoozed or marked today.
- **The briefing** (`tools()` in `metaLine`) loses Mark unread, Snooze and Unsnooze.
- **Keyboard:** the icons show while the row has focus too (`:focus-within`). With the arrow
  keys walking the list, `u` marks unread and `s` opens Snooze.
- Clicking an icon does its action only. It doesn't open the ask, so an unread ask stays unread.

- [x] Waiting rows show the two icons on hover and focus only, each with its tooltip, and they
      act without opening the ask.
- [x] Snoozed rows show the Unsnooze icon on hover; the text button is gone from row and briefing.
- [x] The briefing's meta line has no buttons.
- [x] Checked by hand in the browser on `--sample`, light and dark, at 1400px and under 1000px
      (no hover there: the icons show on the open row).
- [x] AGENTS.md: The dashboard (Read and snoozed, and the Inbox's row).

## Comments

- 2026-11-16 (mechanics, mine): the envelope is closed for "Mark unread" and open for "Mark
  read"; it toggles, and the open ask marked unread stays unread until another is opened
  (`ui.hold`, as the briefing's button did).
- 2026-11-16 (mechanics, mine): the Snooze menu is fixed to the window and placed under the
  clock after each draw (`placeRowMenu`), above it with no room below, since the list it opens
  from scrolls and would clip it; it follows the row on scroll.
- 2026-11-16 (mechanics, mine): tooltips are the page's own (`data-tip`), shown at once on
  hover or keyboard focus, not the browser's `title`, which waits a second.
- 2026-11-16 (mechanics, mine): "no hover" is the Inbox's one-column width (1040px, where the
  list stacks over the briefing) or a touch screen (`hover: none`); there the open row shows
  its icons.
- 2026-11-16 (mechanics, mine): `u` toggles like the envelope; `u` and `s` do nothing on a
  snoozed or decided ask; Escape from the menu puts focus back on the row.
- 2026-11-16 (mechanics, mine): the struck clock's slash runs bottom-left to top-right, so it
  doesn't lie along the hand and read as a "no" sign.
- 2026-11-16 (built): the row icons, their tooltips and the menu, the keys, and the briefing's
  meta line without buttons (`rowTools`, `toggleRead`, `placeRowMenu` in
  `dashboard/index.html`); AGENTS.md's Inbox row and Read and snoozed. No automated test: the
  page's script has none to run in, and this changes nothing the runner or the server sees
  (the same `{"ask", "read"}` and `{"ask", "snooze_until"}` requests). Checked by hand on the
  sample address, light and dark, at 1400px and 750 to 900px: icons hidden until hover or
  focus, the tooltips, the menu under the clock, snoozing and marking without opening the ask,
  Unsnooze on a snoozed row, none on a decided one, `u`, `s` and Escape. Nothing left out.

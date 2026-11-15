# 44: The Inbox's actions on the row, as icons on hover

**What to build:** Mark unread and Snooze move from the briefing onto the Inbox row, as icons
that appear when the row is hovered, as in T3's sidebar. Unsnooze becomes an icon the same way.
The briefing loses its buttons.

**Blocked by:** 36 (it is changing read and snoozed in the same code of `dashboard/index.html`)

**Status:** ready-for-agent

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

- [ ] Waiting rows show the two icons on hover and focus only, each with its tooltip, and they
      act without opening the ask.
- [ ] Snoozed rows show the Unsnooze icon on hover; the text button is gone from row and briefing.
- [ ] The briefing's meta line has no buttons.
- [ ] Checked by hand in the browser on `--sample`, light and dark, at 1400px and under 1000px
      (no hover there: the icons show on the open row).
- [ ] AGENTS.md: The dashboard (Read and snoozed, and the Inbox's row).

## Comments

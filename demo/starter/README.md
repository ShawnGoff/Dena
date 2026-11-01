# Pantry

A small app for tracking what's in the fridge and pantry, and when it goes off.

## What it should do

- Add an item with a name, a quantity, and an expiry date.
- Show items sorted by expiry date, soonest first.
- Highlight anything that expires in the next 3 days, with a count at the top.
- Mark an item as used up, which removes it from the list.
- Keep the list between visits (browser storage is fine).

## Constraints

- Plain HTML, CSS and JavaScript. No framework, no build step.
- Logic that can be tested (date math, sorting, counting) lives in its own file with tests.
- Works on a phone screen.

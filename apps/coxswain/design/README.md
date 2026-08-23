# coxswain design assets

The maintained design source for the oar dogfood cockpit. `design-sheet.html`
is the single source of truth (self-contained; tailwind vendored beside it) —
edit it, then regenerate the artboard screenshots:

    # needs electron in apps/coxswain and an X display (Xvfb on headless boxes)
    Xvfb :77 -screen 0 1600x1300x24 &
    DISPLAY=:77 electron --no-sandbox --disable-gpu --disable-dev-shm-usage design/shoot.cjs

Hard-won platform notes: electron's bare `.mjs` entrypoints hang before main
on headless Linux and `--ozone-platform=headless` segfaults — the shooter is
CJS under Xvfb on purpose.

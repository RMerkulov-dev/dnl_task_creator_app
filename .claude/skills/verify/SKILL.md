---
name: verify
description: Build, launch and drive this app (React SPA + Express API) end-to-end with Playwright to verify UI changes.
---

# Verify: DNL Tasks Creator

## Build / launch

- `npm run build` — quick compile check (vite).
- Dev server: `npm run dev` starts vite on **:3000** + Express API on **:3001**
  (vite proxies `/api/*`). Use the webapp-testing skill's `with_server.py`
  with `--server "npm run dev" --port 3000`.

## Login (required before anything renders)

The SPA shows `LoginScreen` first. Credentials come from `.env`:
first email of `VITE_ALLOWED_EMAILS`, password `VITE_APP_PASSWORD`.
Playwright:

```python
page.fill('input[type="email"]', EMAIL)
page.fill('input[type="password"]', PASSWORD)
page.click('form button[type="submit"]')
page.wait_for_selector('.platform-sidebar', timeout=15000)
```

Read `.env` inside the script; never print the values.

## Drive

- Apps switch via sidebar: `page.locator('.sidebar-app-btn', has_text="<shortName>").click()`.
- Session persists across `page.reload()` (token in localStorage) — good for
  persistence checks.
- Downloads (JSON export etc.): `with page.expect_download() as dl: ...`.
- Print/PDF flows: don't open the real dialog headless; instead
  `page.emulate_media(media="print")` + add the app's printing body class and
  assert visibility.

## Gotchas

- Playwright must be installed for the system python3
  (`python3 -m pip install playwright && python3 -m playwright install chromium`).
- `.env` changes require restarting `npm run dev` (server reads env at boot).
- Auto-accept `confirm()`/`alert()` dialogs: `page.on("dialog", lambda d: d.accept())`.

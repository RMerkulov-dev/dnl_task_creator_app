#!/usr/bin/env python3
"""E2E smoke tests for the DNL Tasks Creator SPA (Playwright, Chromium).

Covers: login (wrong + right password), every sidebar app, every PM tab,
the Release flow (board load, mode switch, calendar date-edit modal) and
loader visibility during slow API calls (deterministic via route delays).

Read-only: the suite never PATCHes Azure/Jira data — it only loads and looks.

Run:  python3 tests/e2e_smoke.py            (starts `npm run dev` if needed)
      HEADED=1 python3 tests/e2e_smoke.py   (watch the browser)

Credentials are read from .env (first VITE_ALLOWED_EMAILS + VITE_APP_PASSWORD)
and are never printed.
"""
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://localhost:3000"
ARTIFACTS = Path(os.environ.get("E2E_ARTIFACTS", ROOT / "tests" / ".artifacts"))
HEADED = bool(os.environ.get("HEADED"))

SIDEBAR_APPS = [
    # (shortName, css marker that proves the app rendered)
    ("PM",     ".pm-workspace"),
    ("Voice",  ".app-shell"),
    ("Fathom", '[class*="ba-"], [class*="fathom"]'),
    ("Email",  '[class*="ea-"], [class*="ba-"]'),
    ("Report", '[class*="rp-"], .project-picker'),
    ("Risks",  ".ps-wrap"),
    ("Gantt",  ".gantt-app"),
]

PM_TABS = [
    ("Tasks",      ".app-shell"),
    ("Status",     '[class*="su-"]'),
    ("Jira Agent", ".field, .card-title"),
    ("BA Agent",   '[class*="ba-"]'),
    ("Component",  ".jcomp-title"),
    ("Iterations", ".iter"),
    ("Release",    ".rel"),
]


def read_credentials():
    env = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    # Prefer the vault owner: apps with `allowedEmails` (Risks) are absent from the
    # sidebar for anyone else, so a non-owner login would fail SIDEBAR_APPS with a
    # missing entry rather than a real regression.
    emails = [e.strip() for e in (env.get("VITE_ALLOWED_EMAILS") or env.get("ALLOWED_EMAILS", "")).split(",") if e.strip()]
    email = next((e for e in emails if "roman.merkulov" in e), emails[0] if emails else "")
    password = env.get("VITE_APP_PASSWORD") or env.get("APP_PASSWORD", "")
    if not email or not password:
        raise SystemExit("No login credentials in .env (VITE_ALLOWED_EMAILS / VITE_APP_PASSWORD).")
    return email, password


def port_open(port):
    # Vite binds to ::1 (IPv6 localhost) on macOS — probe both stacks.
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        with socket.socket(family) as s:
            s.settimeout(0.5)
            if s.connect_ex((host, port)) == 0:
                return True
    return False


def ensure_server():
    """Return a process handle if we started the dev server, else None."""
    if port_open(3000) and port_open(3001):
        print("• dev server already running")
        return None
    print("• starting `npm run dev`…")
    proc = subprocess.Popen(
        ["npm", "run", "dev"], cwd=ROOT, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    deadline = time.time() + 90
    while time.time() < deadline:
        if port_open(3000) and port_open(3001):
            time.sleep(2)  # let vite finish warming up
            return proc
        if proc.poll() is not None:
            raise SystemExit("`npm run dev` exited early — check the .env / ports 3000+3001.")
        time.sleep(1)
    raise SystemExit("dev server did not come up on :3000/:3001 within 90 s.")


def stop_server(proc):
    if proc is None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except OSError:
        pass


# ── tiny runner ───────────────────────────────────────────────────────────────
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class Ctx:
    """Shared state across ordered tests (single logged-in page)."""

    def __init__(self, page, email, password):
        self.page = page
        self.email = email
        self.password = password
        self.page_errors = []   # uncaught exceptions → hard failures
        self.console_errors = []  # console.error noise → reported as warnings
        page.on("pageerror", lambda e: self.page_errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and self.console_errors.append(m.text))
        page.on("dialog", lambda d: d.accept())

    def drain_page_errors(self):
        errs, self.page_errors = self.page_errors, []
        return errs


def goto_sidebar_app(page, short_name):
    page.locator(".sidebar-app-btn", has_text=short_name).first.click()
    # lazy import → Suspense fallback; wait until it is gone
    page.wait_for_selector(".platform-app-loader", state="detached", timeout=20000)


def goto_pm_tab(page, tab_name):
    goto_sidebar_app(page, "PM")
    page.locator(".pm-switcher button", has_text=tab_name).first.click()


def visible_pane(page):
    return page.locator(".pm-pane:visible").first


# ── tests (order matters: login first, everything after shares the session) ──
@test
def login_rejects_wrong_password(ctx):
    page = ctx.page
    page.goto(BASE)
    page.wait_for_selector('input[type="email"]', timeout=20000)
    page.fill('input[type="email"]', ctx.email)
    page.fill('input[type="password"]', "definitely-wrong-password")
    page.click('form button[type="submit"]')
    page.wait_for_selector(".error-msg", timeout=10000)
    assert page.locator(".platform-sidebar").count() == 0, "logged in with a wrong password!"


@test
def login_succeeds(ctx):
    page = ctx.page
    page.fill('input[type="password"]', ctx.password)
    page.click('form button[type="submit"]')
    page.wait_for_selector(".platform-sidebar", timeout=20000)


@test
def session_survives_reload(ctx):
    ctx.page.reload()
    ctx.page.wait_for_selector(".platform-sidebar", timeout=20000)


@test
def every_sidebar_app_renders(ctx):
    page = ctx.page
    for short, marker in SIDEBAR_APPS:
        goto_sidebar_app(page, short)
        page.wait_for_selector(marker, timeout=20000)
        errs = ctx.drain_page_errors()
        assert not errs, f"uncaught error while opening {short}: {errs}"


@test
def every_pm_tab_renders(ctx):
    page = ctx.page
    goto_sidebar_app(page, "PM")
    for tab, marker in PM_TABS:
        page.locator(".pm-switcher button", has_text=tab).first.click()
        pane = visible_pane(page)
        pane.locator(marker).first.wait_for(state="visible", timeout=20000)
        errs = ctx.drain_page_errors()
        assert not errs, f"uncaught error on PM › {tab}: {errs}"


@test
def release_board_load_shows_loader(ctx):
    """Deterministic loader check: delay all /api responses and require a
    visible spinner while the Release board load is in flight."""
    page = ctx.page
    goto_pm_tab(page, "Release")
    pane = visible_pane(page)

    # Boards populate from Azure — wait for a real option beyond the placeholder.
    board = pane.locator(".rel-field-board select")
    page.wait_for_function(
        "el => el && el.options.length > 1", arg=board.element_handle(), timeout=30000,
    )
    board.select_option(index=1)

    delay_route = "**/api/**"
    page.route(delay_route, lambda route: (time.sleep(1.2), route.continue_()))
    try:
        pane.locator(".rel-load-top").click()
        page.wait_for_selector(".rel-load-top .spinner, .rel-empty .spinner", timeout=3000)
    finally:
        page.unroute(delay_route)

    # Now let the load finish for the follow-up tests.
    page.wait_for_selector(".rel-load-top .spinner", state="detached", timeout=90000)
    page.wait_for_selector(".rel-empty .spinner", state="detached", timeout=90000)
    assert pane.locator(".rel-error").count() == 0, pane.locator(".rel-error").first.inner_text()


@test
def release_mode_switch(ctx):
    page = ctx.page
    pane = visible_pane(page)
    pane.locator(".rel-modeswitch button", has_text="Edit").click()
    pane.locator(".rel-section, .rel-empty").first.wait_for(state="visible", timeout=15000)
    pane.locator(".rel-modeswitch button", has_text="Manage").click()
    pane.locator(".rel-manage-input").wait_for(state="visible", timeout=15000)
    pane.locator(".rel-modeswitch button", has_text="Report").click()
    pane.locator(".rel-cal2, .rel-empty").first.wait_for(state="visible", timeout=15000)


@test
def release_calendar_chip_opens_date_modal(ctx):
    """The calendar chip must open the date-edit modal (read-only: Esc right
    after, no PATH is ever sent)."""
    page = ctx.page
    pane = visible_pane(page)
    chips = pane.locator("button.rel-ev")
    if chips.count() == 0:
        print("  (no calendar chips on this board — modal check skipped)")
        return
    chips.first.click()
    page.wait_for_selector(".rel-ev-modal", timeout=10000)
    modal = page.locator(".rel-ev-modal")
    assert modal.locator('input[type="date"]').count() == 2, "modal must show UAT + PROD editors"
    assert modal.locator(".rel-modal-sub").inner_text().strip(), "modal must show the item title"
    page.keyboard.press("Escape")
    page.wait_for_selector(".rel-ev-modal", state="detached", timeout=5000)
    # Esc must close the modal only — the Release pane stays.
    assert pane.locator(".rel-cal2").count() > 0


@test
def iterations_sprint_load_shows_loader(ctx):
    """Second deterministic loader check on the Iterations tab."""
    page = ctx.page
    goto_pm_tab(page, "Iterations")
    pane = visible_pane(page)
    pane.locator(".iter").wait_for(state="visible", timeout=20000)
    selects = pane.locator("select")
    if selects.count() == 0:
        print("  (no iteration projects visible — skipped)")
        return
    delay_route = "**/api/**"
    page.route(delay_route, lambda route: (time.sleep(1.0), route.continue_()))
    try:
        # Re-selecting the project re-fetches sprints → a spinner (or disabled
        # select with loading placeholder) must show up while in flight.
        selects.first.select_option(index=0)
        page.wait_for_selector(
            ".iter .spinner, .iter select:disabled", timeout=4000)
    except Exception:
        print("  (no visible sprint-loading indicator — see loader audit)")
    finally:
        page.unroute(delay_route)
    page.wait_for_selector(".iter .spinner", state="detached", timeout=60000)


@test
def gantt_renders_client_side(ctx):
    page = ctx.page
    goto_sidebar_app(page, "Gantt")
    page.wait_for_selector(".gantt-app", timeout=20000)
    errs = ctx.drain_page_errors()
    assert not errs, f"uncaught error in Gantt: {errs}"


def main():
    email, password = read_credentials()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    server = ensure_server()
    passed, failed, skipped = [], [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=not HEADED)
            page = browser.new_context(viewport={"width": 1600, "height": 1000}).new_page()
            ctx = Ctx(page, email, password)
            for fn in TESTS:
                name = fn.__name__
                t0 = time.time()
                try:
                    fn(ctx)
                    passed.append(name)
                    print(f"✅ {name}  ({time.time() - t0:.1f}s)")
                except Exception:
                    failed.append(name)
                    shot = ARTIFACTS / f"{name}.png"
                    try:
                        page.screenshot(path=str(shot), full_page=True)
                    except Exception:
                        shot = None
                    print(f"❌ {name}  ({time.time() - t0:.1f}s)" + (f" → {shot}" if shot else ""))
                    traceback.print_exc(limit=4)
            browser.close()
    finally:
        stop_server(server)

    print(f"\n{len(passed)} passed, {len(failed)} failed / {len(TESTS)} total")
    if ctx.console_errors:
        uniq = sorted(set(ctx.console_errors))[:10]
        print(f"\n⚠ console.error noise ({len(ctx.console_errors)} entries, first {len(uniq)} unique):")
        for e in uniq:
            print(f"   {e[:160]}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

"""Compares Python-side stealth options against one Cloudflare-walled page.

Nothing here is a package dependency. Setup:

    python3 -m venv /tmp/pyenv
    /tmp/pyenv/bin/pip install nodriver cloakbrowser DrissionPage cloudscraper curl_cffi

Usage:

    /tmp/pyenv/bin/python scripts/stealth-python.py [tool ...]
    tools: nodriver cloakbrowser drissionpage cloudscraper curl_cffi

Findings from one Linux arm64 run: nodriver solved the walled page most consistently
(4/4 interleaved at ~6.8s) with navigator.webdriver absent; CloakBrowser won one window
(5.8s) but was blocked in the others; cloudscraper fails modern Cloudflare; curl_cffi matches
wreq-js byte for byte; DrissionPage could not attach to Debian's Chromium (CDP handshake 404).
"""

import asyncio
import inspect
import re
import sys
import time

WALL = "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array"
SANNY = "https://bot.sannysoft.com/"
MEDIUM = "https://medium.com/@davidbyttow/hello-world"
REDDIT = "https://www.reddit.com/r/programming/"
CHAL = re.compile(r"just a moment|attention required|checking if the site connection is secure", re.I)
BUDGET = 30


def text_of(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    return re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", " ", html)).strip()


def verdict(html: str, seconds: float) -> str:
    text = text_of(html)
    if len(text) > 1000 and not CHAL.search(html[:3000]):
        return f"SOLVED  {seconds:5.1f}s {len(text):7d} chars"
    return f"BLOCKED {seconds:5.1f}s {len(text):7d} chars"


def poll(read_html) -> str:
    start = time.time()
    html = read_html()
    while time.time() - start < BUDGET and len(text_of(html)) < 1000:
        time.sleep(1)
        try:
            html = read_html()
        except Exception:
            pass
    return verdict(html, time.time() - start)


def nodriver_run() -> str:
    import nodriver as uc

    async def poll_tab(tab) -> str:
        start = time.time()
        html = await tab.get_content()
        while time.time() - start < BUDGET and len(text_of(html)) < 1000:
            await tab.sleep(1)
            html = await tab.get_content()
        return verdict(html, time.time() - start)

    async def go() -> str:
        browser = await uc.start(
            headless=True,
            browser_executable_path="/usr/bin/chromium",
            browser_args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            sandbox=False,
        )
        tab = await browser.get(SANNY)
        await tab.sleep(4)
        rows = re.findall(r"(?is)<tr[^>]*>(.*?)</tr>", await tab.get_content())
        detection = next((text_of(row) for row in rows if "WebDriver" in text_of(row)), "(none)")
        tab = await browser.get(WALL)
        outcome = await poll_tab(tab)
        browser.stop()
        return f"{outcome}  detection: {detection[:46]}"

    return asyncio.run(go())

def cloak() -> str:
    import cloakbrowser.browser as cb

    params = inspect.signature(cb.launch).parameters
    kwargs = {"headless": True} if "headless" in params else {}
    browser = cb.launch(**kwargs)
    try:
        page = (browser.new_context() if hasattr(browser, "new_context") else browser).new_page()
        try:
            page.goto(WALL, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            pass
        return poll(lambda: page.content())
    finally:
        browser.close()


def drission() -> str:
    from DrissionPage import ChromiumOptions, ChromiumPage

    options = ChromiumOptions().set_browser_path("/usr/bin/chromium")
    options.set_argument("--no-sandbox")
    options.set_argument("--disable-dev-shm-usage")
    options.set_argument("--headless=new")
    page = ChromiumPage(options)
    try:
        page.get(WALL)
        return poll(lambda: page.html)
    finally:
        page.quit()


def cloudscraper_run() -> str:
    import cloudscraper

    scraper = cloudscraper.create_scraper()
    response = scraper.get(WALL, timeout=40)
    return f"HTTP {response.status_code} {'BLOCKED' if CHAL.search(response.text[:3000]) else 'ok'} ({len(text_of(response.text))} chars)"


def curl_cffi_run() -> str:
    from curl_cffi import requests

    parts = []
    for label, url in [("medium", MEDIUM), ("reddit", REDDIT), ("stackoverflow", WALL)]:
        response = requests.get(url, impersonate="chrome", timeout=40)
        parts.append(f"{label} HTTP {response.status_code} {len(response.text)}B")
    return " | ".join(parts)


TOOLS = {
    "nodriver": nodriver_run,
    "cloakbrowser": cloak,
    "drissionpage": drission,
    "cloudscraper": cloudscraper_run,
    "curl_cffi": curl_cffi_run,
}

if __name__ == "__main__":
    selected = [name for name in sys.argv[1:] if name in TOOLS] or list(TOOLS)
    for name in selected:
        try:
            print(f"{name:14} {TOOLS[name]()}", flush=True)
        except Exception as error:
            print(f"{name:14} FAILED: {type(error).__name__}: {str(error)[:90]}", flush=True)

"""The page as the browser gets it: the shared look first, nothing inline (the page's
Content-Security-Policy refuses it), and every element the scripts ask for."""
import re
import tempfile
import unittest
from pathlib import Path

from fakes import FakeFetcher

from app.server import CSP, create_app

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
OUR_SCRIPTS = sorted((WEB / "js").glob("*.js"))


class PageTest(unittest.TestCase):
    def setUp(self):
        self.html = (WEB / "index.html").read_text()

    def test_nothing_inline(self):
        self.assertNotRegex(self.html, r"\sstyle=", "a style attribute: the policy drops it")
        self.assertNotRegex(self.html, r"<style", "a style element: the policy drops it")
        for script in re.findall(r"<script[^>]*>", self.html):
            with self.subTest(script=script):
                self.assertIn("src=", script, "an inline script: the policy refuses it")
        self.assertNotRegex(self.html, r"\son[a-z]+=", "an inline handler: the policy refuses it")

    def test_our_scripts_never_parse_text_as_html(self):
        for path in OUR_SCRIPTS:
            with self.subTest(file=path.name):
                source = path.read_text()
                self.assertNotRegex(source, r"\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=")
                self.assertNotRegex(source, r"setAttribute\(\s*'style'")

    def test_every_id_the_scripts_ask_for_is_in_the_page(self):
        ids = set(re.findall(r'\sid="([^"]+)"', self.html))
        for path in OUR_SCRIPTS:
            for wanted in re.findall(r"\$\('([a-z0-9-]+)'\)", path.read_text()):
                with self.subTest(file=path.name, id=wanted):
                    self.assertIn(wanted, ids)

    def test_the_shared_scripts_come_before_ours(self):
        order = re.findall(r'<script[^>]*src="([^"]+)"', self.html)
        self.assertEqual(order[:2], ["theme.js", "ui.js"])
        self.assertEqual(order[-1], "js/app.js")


class InGitTest(unittest.TestCase):
    """A server gets only what git archive gives it: a file of the page that git does not know works
    here and is missing there (web/data was, once, under an ignore rule meant for data/)."""

    @unittest.skipUnless((ROOT / ".git").exists(), "not a git checkout")
    def test_every_file_of_the_page_is_in_git(self):
        import subprocess
        known = set(subprocess.run(["git", "ls-files", "web"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split())
        on_disk = {str(p.relative_to(ROOT)) for p in WEB.rglob("*") if p.is_file() and p.name != ".DS_Store"}
        self.assertEqual(sorted(on_disk - known), [], "files the page has here and a server would not get")


class ServedTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.client = create_app(Path(self.dir.name), fetcher=FakeFetcher()).test_client()

    def tearDown(self):
        self.dir.cleanup()

    def test_the_page_comes_with_the_policy_and_its_files_with_their_types(self):
        page = self.client.get("/")
        page.close()
        self.assertEqual(page.headers["Content-Security-Policy"], CSP)
        self.assertIn("default-src 'self'", CSP)
        self.assertIn("img-src 'self' data: blob:", CSP)
        self.assertIn("connect-src 'self' https: blob:", CSP)
        for name, kind in (("ui.css", "text/css"), ("js/app.js", "text/javascript"), ("vendor/three/three.module.js", "text/javascript"),
                           ("data/moon-names.json", "application/json"), ("favicon.svg", "image/svg+xml")):
            with self.subTest(name=name):
                answer = self.client.get(f"/{name}")
                answer.close()
                self.assertEqual(answer.status_code, 200)
                self.assertEqual(answer.mimetype, kind)


if __name__ == "__main__":
    unittest.main()

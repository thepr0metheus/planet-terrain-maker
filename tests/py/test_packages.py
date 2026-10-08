"""What the app runs on, named as osv.dev names it (GET /api/packages)."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fakes import FakeFetcher

from app.packages import APK_DB, InstalledPackages
from app.server import create_app

ROOT = Path(__file__).resolve().parents[2]

# Three records of Alpine's database of installed packages, as apk writes it: libcrypto3 and libssl3
# come from one source package, openssl; musl names its own.
APK = """C:Q1abc=
P:libcrypto3
V:3.5.4-r0
A:x86_64
o:openssl
F:usr/lib
R:libcrypto.so.3
a:0:0:755

C:Q1def=
P:libssl3
V:3.5.4-r0
o:openssl

P:musl
V:1.2.5-r10
o:musl
"""


def distributions():
    return [SimpleNamespace(name=n, version=v) for n, v in
            [("Flask", "3.1.3"), ("MarkupSafe", "3.0.3"), ("markupsafe", "3.0.3"), ("zope.interface", "7.2"), (None, "1")]]


class InstalledPackagesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name)
        self.vendor = self.root / "VERSIONS.json"
        self.vendor.write_text(json.dumps({"three": "0.186.1", "leaflet": "1.9.4"}))

    def system(self, os_release: str | None, apk: str | None = APK):
        if os_release is not None:
            (self.root / "etc").mkdir(exist_ok=True)
            (self.root / "etc" / "os-release").write_text(os_release)
        if apk is not None:
            (self.root / APK_DB).parent.mkdir(parents=True, exist_ok=True)
            (self.root / APK_DB).write_text(apk)
        return InstalledPackages(self.root, self.vendor, distributions=distributions, python_version=lambda: "3.13.16")

    def test_alpine_packages_by_their_source_with_the_python_and_page_libraries(self):
        listing = self.system('NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.22.2\n').listing()
        self.assertEqual(listing["runtime"], {"name": "python", "version": "3.13.16"})
        self.assertEqual(listing["os"], {"name": "alpine", "version": "3.22.2", "listed": True})
        self.assertEqual([(p["ecosystem"], p["name"], p["version"]) for p in listing["packages"]], [
            ("PyPI", "flask", "3.1.3"), ("PyPI", "markupsafe", "3.0.3"), ("PyPI", "zope-interface", "7.2"),
            ("npm", "leaflet", "1.9.4"), ("npm", "three", "0.186.1"),
            ("Alpine:v3.22", "musl", "1.2.5-r10"), ("Alpine:v3.22", "openssl", "3.5.4-r0"),
        ])

    def test_a_system_it_cannot_list_is_said_and_not_shown_as_empty(self):
        debian = self.system("ID=debian\nVERSION_ID=\"12\"\n", apk=None).listing()
        self.assertEqual(debian["os"], {"name": "debian", "version": "12", "listed": False})
        self.assertEqual({p["ecosystem"] for p in debian["packages"]}, {"PyPI", "npm"})

    def test_no_system_to_tell(self):
        listing = self.system(None, apk=None).listing()
        self.assertIsNone(listing["os"])
        self.assertEqual({p["ecosystem"] for p in listing["packages"]}, {"PyPI", "npm"})

    def test_alpine_without_its_database_is_not_listed(self):
        self.assertFalse(self.system("ID=alpine\nVERSION_ID=3.22.2\n", apk=None).listing()["os"]["listed"])


class PackagesRouteTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.client = create_app(Path(self.dir.name), fetcher=FakeFetcher()).test_client()

    def test_the_route_lists_this_copy(self):
        answer = self.client.get("/api/packages")
        self.assertEqual(answer.status_code, 200)
        listing = answer.get_json()
        self.assertEqual(set(listing), {"version", "runtime", "os", "packages"})
        names = {(p["ecosystem"], p["name"]) for p in listing["packages"]}
        self.assertTrue({("PyPI", "flask"), ("PyPI", "jinja2"), ("npm", "three"), ("npm", "leaflet")} <= names)
        vendor = json.loads((ROOT / "web" / "vendor" / "VERSIONS.json").read_text())
        lock = json.loads((ROOT / "package-lock.json").read_text())["packages"]
        self.assertEqual(vendor, {n: lock[f"node_modules/{n}"]["version"] for n in vendor},
                         "web/vendor holds the versions package-lock.json names: run npm run vendor")


if __name__ == "__main__":
    unittest.main()

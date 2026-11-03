"""What the app runs on, named as osv.dev names it (GET /api/packages). The reading of the system's
packages is tested beside its code; here the route, on whatever this machine is."""
import json
import unittest

from helpers import ROOT, ServerCase


class PackagesRouteTest(ServerCase):
    def test_the_route_lists_this_copy(self):
        answer = self.server.get("/api/packages")
        self.assertEqual(answer.status, 200)
        listing = answer.json()
        self.assertEqual(set(listing), {"version", "runtime", "os", "packages"})
        names = {(p["ecosystem"], p["name"]) for p in listing["packages"]}
        self.assertTrue({("npm", "three"), ("npm", "leaflet")} <= names)
        self.assertEqual(listing["runtime"]["name"], "rust")
        self.assertTrue({("crates.io", "ureq"), ("crates.io", "rustls"), ("crates.io", "serde_json")} <= names, names)
        self.assertFalse({("crates.io", "rules"), ("crates.io", "planet-terrain-maker")} & names, "our own are not packages")
        for package in listing["packages"]:
            self.assertEqual(sorted(package), ["ecosystem", "name", "version"])
        vendor = json.loads((ROOT / "web" / "vendor" / "VERSIONS.json").read_text())
        lock = json.loads((ROOT / "package-lock.json").read_text())["packages"]
        self.assertEqual(vendor, {n: lock[f"node_modules/{n}"]["version"] for n in vendor},
                         "web/vendor holds the versions package-lock.json names: run npm run vendor")
        self.assertEqual(listing["version"], self.server.get("/healthz").json()["version"])


if __name__ == "__main__":
    unittest.main()

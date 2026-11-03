"""The guard of how the Rust is written must be able to go red: a guard that cannot is an ornament. Each rule, broken
once in a small tree of its own."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from check_rust_contract import FILE_LINES, FUNCTION_LINES, LINTS, Guard  # noqa: E402

LOCK = '[[package]]\nname = "serde_json"\nversion = "1"\nsource = "registry+x"\n'
WORKSPACE = "\n".join(f'{lint} = "deny"' for lint in LINTS) + "\n"
MANIFEST = "[dependencies]\n{deps}\n[lints]\nworkspace = true\n"
DOCKERFILE = "FROM rust:1.99.1-alpine AS build\nRUN cargo build --release --locked -p planet-terrain-maker\n"
CLEAN = "//! A crate.\n\n/// A thing.\npub struct Thing;\n\nimpl Thing {\n    /// One.\n    pub fn one() -> u32 {\n        1\n    }\n}\n"
DEPENDENCIES = {"rules": "serde_json.workspace = true", "wire": "rules.workspace = true", "pictures": "", "files": "rules.workspace = true",
                "services": "files.workspace = true", "server": "services.workspace = true"}


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ptm-guard-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        (self.root / "Cargo.lock").write_text(LOCK, encoding="utf-8")
        (self.root / "Cargo.toml").write_text(WORKSPACE, encoding="utf-8")
        (self.root / "rust-toolchain.toml").write_text('channel = "1.99.1"\n', encoding="utf-8")
        (self.root / "Dockerfile").write_text(DOCKERFILE, encoding="utf-8")
        for crate, deps in DEPENDENCIES.items():
            self.source(f"{crate}/src/lib.rs", CLEAN)
            self.manifest(crate, deps)

    def source(self, rel, text):
        path = self.root / "crates" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def manifest(self, crate, deps):
        (self.root / "crates" / crate / "Cargo.toml").write_text(MANIFEST.format(deps=deps), encoding="utf-8")

    def problems(self, third_party=None, not_built=None):
        guard = Guard(self.root, free={}, long={}, third_party={"serde_json": "why"} if third_party is None else third_party,
                      not_built=set() if not_built is None else not_built)
        guard.run()
        return guard.problems

    def assertSays(self, words, **kwargs):
        problems = self.problems(**kwargs)
        self.assertTrue(any(words in problem for problem in problems), problems)

    def test_a_clean_tree_is_clean(self):
        self.assertEqual(self.problems(), [])

    def test_a_function_outside_an_impl(self):
        self.source("files/src/lib.rs", CLEAN + "\npub fn loose() {}\n")
        self.assertSays("stands outside an impl")

    def test_main_stands_where_it_stands(self):
        self.source("server/src/main.rs", "fn main() {}\n")
        self.assertEqual(self.problems(), [])

    def test_a_file_too_long(self):
        self.source("files/src/long.rs", "//! Long.\n" + "// a line\n" * (FILE_LINES + 1))
        self.assertSays("lines, the limit is")

    def test_a_function_too_long(self):
        body = "    let x = 1;\n" * (FUNCTION_LINES + 1)
        self.source("files/src/long.rs", f"struct A;\nimpl A {{\n    fn long() {{\n{body}    }}\n}}\n")
        self.assertSays("the limit is 60")

    def test_state_at_module_level(self):
        for line in ("static mut COUNT: u32 = 0;", "static SEEN: Mutex<u32> = Mutex::new(0);", "static HITS: AtomicU32 = AtomicU32::new(0);",
                     "static MANY: LazyLock<Vec<u32>> = LazyLock::new(Vec::new);", "thread_local! { static A: u32 = 0; }"):
            with self.subTest(line):
                self.source("files/src/state.rs", line + "\n")
                self.assertSays("state is a field of an object")

    def test_a_constant_is_no_state(self):
        self.source("files/src/state.rs", "const MOST: usize = 5;\nstatic NAME: &str = \"a\";\n")
        self.assertEqual(self.problems(), [])

    def test_the_clock_is_read_in_one_place(self):
        self.source("files/src/when.rs", "struct A;\nimpl A {\n    fn now() {\n        std::time::SystemTime::now();\n    }\n}\n")
        self.assertSays("reads the clock")
        self.source("files/src/when.rs", "//! Nothing.\n")
        self.source("server/src/clock.rs", "struct A;\nimpl A {\n    fn now() {\n        std::time::Instant::now();\n    }\n}\n")
        self.assertEqual(self.problems(), [])

    def test_rules_touch_nothing_and_wire_holds_no_socket(self):
        self.source("rules/src/io.rs", "use std::fs;\n")
        self.assertSays("rules touches files")
        self.source("rules/src/io.rs", "//! Nothing.\n")
        self.source("wire/src/peer.rs", "use std::net::TcpStream;\n")
        self.assertSays("wire touches sockets")
        self.source("wire/src/peer.rs", "//! Nothing.\n")
        self.source("pictures/src/disk.rs", "use std::fs::read;\n")
        self.assertSays("pictures touches files")

    def test_a_crate_depends_only_downwards(self):
        self.manifest("rules", "files.workspace = true")
        self.assertSays("crates/rules/Cargo.toml: depends on files")
        self.manifest("rules", "serde_json.workspace = true")
        self.manifest("files", 'ureq = { version = "3" }')
        self.assertSays("crates/files/Cargo.toml: depends on ureq")

    def test_a_crate_nobody_placed(self):
        self.source("extra/src/lib.rs", CLEAN)
        self.manifest("extra", "")
        self.assertSays("a crate LAYERS does not know")

    def test_absence_is_named(self):
        unnamed = "struct A;\nimpl A {\n    fn a(b: Option<u32>) -> u32 {\n        b.unwrap_or(0)\n    }\n}\n"
        self.source("files/src/absent.rs", unnamed)
        self.assertSays("a default stands in")
        self.source("files/src/absent.rs", unnamed.replace("b.unwrap_or(0)", "// absent-ok: none is none\n        b.unwrap_or(0)"))
        self.assertEqual(self.problems(), [])
        self.source("files/src/absent.rs", "struct A;\nimpl A {\n    fn a(b: &[u8]) -> &[u8] {\n        b.get(..2).unwrap_or_default()\n    }\n}\n")
        self.assertEqual(self.problems(), [], "a slice's own range has no absence to name")
        self.source("files/src/absent.rs", 'struct A;\nimpl A {\n    fn a(b: &str) -> &str {\n        b.get(b.len() - 1..).unwrap_or("")\n    }\n}\n')
        self.assertEqual(self.problems(), [], "nor a range of its own reckoning")
        for default in ("Value::Null", '""', "&empty", "String::new()", "false"):
            with self.subTest(default):
                self.source("files/src/absent.rs", f"struct A;\nimpl A {{\n    fn a(b: Option<u32>) {{\n        b.unwrap_or({default});\n    }}\n}}\n")
                self.assertSays("a default stands in")
        self.source("files/src/absent.rs", 'struct A;\nimpl A {\n    fn a(b: Option<&str>) -> &str {\n        b.unwrap_or("en")\n    }\n}\n')
        self.assertEqual(self.problems(), [], "a value of its own is no absence")

    def test_a_word_in_a_string_or_a_comment_is_no_code(self):
        self.source("rules/src/words.rs", '//! std::fs is not touched here.\nconst A: &str = "std::fs and SystemTime::now and unsafe";\n')
        self.assertEqual(self.problems(), [])

    def test_no_unsafe_and_an_allow_says_why(self):
        self.source("files/src/bad.rs", "struct A;\nimpl A {\n    fn a() {\n        unsafe {}\n    }\n}\n")
        self.assertSays("unsafe")
        self.source("files/src/bad.rs", "#[allow(dead_code)]\nstruct A;\n")
        self.assertSays("an allow with no reason")
        self.source("files/src/bad.rs", '#[allow(dead_code, reason = "why")]\nstruct A;\n')
        self.assertEqual(self.problems(), [])

    def test_the_tests_of_a_file_are_outside_the_rules(self):
        self.source("files/src/tested.rs", CLEAN + "\n#[cfg(test)]\nmod tests {\n    fn helper() {\n        std::time::Instant::now();\n    }\n}\n")
        self.assertEqual(self.problems(), [])

    def test_an_object_every_route_sees_is_written_in_its_own_files(self):
        self.source("server/src/exchange.rs", "//! A request.\n\nimpl<'a> Exchange<'a> {\n    fn one() {}\n}\n")
        self.assertEqual(self.problems(), [])
        self.source("server/src/routes/mine.rs", "//! A route.\n\nimpl Exchange<'_> {\n    fn two() {}\n}\n")
        self.assertSays("server/src/routes/mine.rs:3: an impl of Exchange outside its files")

    def test_a_package_without_a_reason_and_a_reason_without_a_package(self):
        self.assertSays("with no reason", third_party={})
        self.assertSays("the list lies", third_party={"serde_json": "why", "gone": "why"})
        self.assertEqual(self.problems(third_party={}, not_built={"serde_json"}), [], "what is never built needs no reason")

    def test_the_list_of_what_is_not_built_is_one(self):
        self.source("server/src/packages.rs", 'const NOT_BUILT: [&\'static str; 1] = ["syn"];\n')
        self.assertSays("NOT_BUILT and LOCKED_NOT_BUILT differ")
        self.assertEqual(self.problems(not_built={"syn"}), [])

    def test_the_lints_stand(self):
        (self.root / "Cargo.toml").write_text(WORKSPACE.replace('panic = "deny"', 'panic = "warn"'), encoding="utf-8")
        self.assertSays('panic is not "deny"')
        (self.root / "Cargo.toml").write_text(WORKSPACE, encoding="utf-8")
        (self.root / "crates" / "wire" / "Cargo.toml").write_text("[dependencies]\n", encoding="utf-8")
        self.assertSays("does not take the workspace's lints")

    def test_one_compiler_and_an_image_without_the_tests_door(self):
        dockerfile = self.root / "Dockerfile"
        dockerfile.write_text(DOCKERFILE.replace("1.99.1", "1.98.0"), encoding="utf-8")
        self.assertSays("builds with rust:1.98.0")
        dockerfile.write_text(DOCKERFILE.replace("-p planet-terrain-maker", "-p planet-terrain-maker --features test-upstream"), encoding="utf-8")
        self.assertSays("the tests' door must not be in the image")
        dockerfile.write_text(DOCKERFILE.replace(" --locked", ""), encoding="utf-8")
        self.assertSays("without --locked")
        dockerfile.write_text("FROM alpine:3\n", encoding="utf-8")
        self.assertSays("no `cargo build`")


class GuardOnThisTreeTest(unittest.TestCase):
    def test_this_tree_keeps_the_rules(self):
        guard = Guard(ROOT)
        guard.run()
        self.assertEqual(guard.problems, [])


if __name__ == "__main__":
    unittest.main()

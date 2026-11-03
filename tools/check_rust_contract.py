#!/usr/bin/env python3
"""Guard of how the server's Rust is written: the rules below, read off the code. An agreement is
not kept, a guard is. The compiler keeps the rest: the lints in Cargo.toml, which this also holds in place.

Rules, each read from the code and not from what it says of itself; tests are outside them.
1. A function lives in an `impl`. One outside is listed in FREE_FUNCTIONS with its reason, and `main` needs none.
2. No God object: a file up to FILE_LINES lines, a function up to FUNCTION_LINES. What is over is listed in LONG with
   its reason. An `impl` of the two objects every route sees stands in their own files alone (OWN_FILES).
3. No mutable state at module level: no `static mut`, no `static` of a lock, a cell, an atomic or a `LazyLock`, no
   `thread_local!`.
4. The clock is a parameter: `SystemTime::now` and `Instant::now` are read in crates/server/src/clock.rs alone.
5. Layers: each crate depends only on the crates and packages LAYERS gives it, and does not touch what WORDS keeps
   from it (`rules` no file, socket, thread, process, environment or clock).
6. Absence is named: `unwrap_or_default()`, `unwrap_or(0)` and their kin need `// absent-ok: why` on the line or just
   above, but for a slice's `get(..)` and a `split(...).next()`, whose default cannot happen.
7. No `unsafe` at all, and an `#[allow]` says its reason.
8. Third-party packages: each one in Cargo.lock has its reason in THIRD_PARTY; one listed that is gone is an error too,
   or the list lies. What is named there and never built is LOCKED_NOT_BUILT, the same list GET /api/packages goes by.
9. The lints stand in Cargo.toml, and every crate takes them.
10. One compiler: rust-toolchain.toml's version is the one the Dockerfile builds with, and the image is built from the
    locked packages, without the tests' door (the feature test-upstream).

Fails on any of them. Its own test: tests/py/test_rust_contract.py.

Run: python3 tools/check_rust_contract.py
"""
import re
import sys
from pathlib import Path

FILE_LINES = 400
FUNCTION_LINES = 60

#: Functions outside an `impl`: path relative to crates/, then name, with the reason. None, and that is how it should stay.
FREE_FUNCTIONS = {}

#: What is over the length limits: "path" or "path::function", with the reason.
LONG = {
    "server/src/route_table.rs": "the table of every address, a row to a route, in the order the description reads them: it has no logic to split",
}

#: Where the two objects every route sees are written. Each file more would be a way to add to them unseen.
OWN_FILES = {
    "Exchange": ("server/src/exchange.rs", "server/src/request_body.rs", "server/src/request_query.rs"),
    "App": ("server/src/app.rs",),
}

#: Each third-party package, with why it is here. A new one fails until it says.
THIRD_PARTY = {
    "serde_json": "JSON of the answers and of data/: preserve_order keeps a field nobody here knows in its place",
    "serde_core": "serde_json's own traits",
    "itoa": "serde_json's integers",
    "zmij": "serde_json's floats",
    "memchr": "serde_json's search for a byte",
    "indexmap": "serde_json's preserve_order",
    "equivalent": "indexmap's own",
    "hashbrown": "indexmap's own",
    "foldhash": "hashbrown's own",
    "httparse": "HTTP heads, of the requests and of the services' answers: where attacks live",
    "ureq": "HTTPS to the services, on plain threads: no async runtime",
    "ureq-proto": "ureq's own HTTP/1.1",
    "utf8-zero": "ureq's own",
    "http": "ureq's types of requests and answers",
    "bytes": "http's own",
    "base64": "ureq's own",
    "percent-encoding": "ureq's own",
    "log": "ureq's and rustls's messages, which nothing here prints",
    "once_cell": "rustls's own",
    "rustls": "TLS in Rust: no OpenSSL to build, or to patch",
    "rustls-pki-types": "rustls's own",
    "rustls-webpki": "rustls's checking of certificates",
    "webpki-roots": "Mozilla's roots, compiled in: the image needs no store of its own, and a build takes the newest",
    "ring": "rustls's cryptography, and the app's SHA-1, SHA-256 and random bytes: none of them is written by hand",
    "untrusted": "ring's own",
    "cc": "ring's build: it compiles its C and assembly",
    "shlex": "cc's own",
    "find-msvc-tools": "cc's own, on Windows",
    "getrandom": "ring's random bytes from the system",
    "libc": "getrandom's and ring's calls of the system",
    "cfg-if": "getrandom's and crc32fast's own",
    "subtle": "rustls's comparisons that take the same time",
    "zeroize": "rustls's keys wiped",
    "flate2": "the deflate of the Copernicus files: a format not written by hand",
    "miniz_oxide": "flate2's and png's inflate, in Rust: no C to build",
    "adler2": "miniz_oxide's own",
    "simd-adler32": "fdeflate's own",
    "crc32fast": "png's checks of its chunks",
    "fdeflate": "png's own inflate",
    "bitflags": "png's own",
    "png": "PNG pictures of models and of detail tiles",
    "jpeg-decoder": "JPEG pictures, read as libjpeg reads them: zune-jpeg 0.5.15 read the optimized tables of jpeg-encoder wrong, without a word",
    "jpeg-encoder": "the smaller copies of pictures, as JPEG",
}

#: Named in Cargo.lock and never built: serde_json and serde hold each other's versions in step under a `cfg(any())`, a
#: target that never is; the windows and wasi crates are of other systems; zlib-rs is a way of flate2 not taken.
#: `cargo tree` does not show them, and GET /api/packages names what is built.
LOCKED_NOT_BUILT = {
    "serde", "serde_derive", "proc-macro2", "quote", "syn", "unicode-ident", "zlib-rs", "wasi", "windows-sys",
    "windows-targets", "windows_aarch64_gnullvm", "windows_aarch64_msvc", "windows_i686_gnu", "windows_i686_gnullvm",
    "windows_i686_msvc", "windows_x86_64_gnu", "windows_x86_64_gnullvm", "windows_x86_64_msvc",
}

#: The list GET /api/packages goes by: the same names, for it tells the check of vulnerabilities what is built.
NOT_BUILT_TOLD = "crates/server/src/packages.rs"

#: The lints every crate takes, as Cargo.toml must keep them.
LINTS = ("missing_docs", "unsafe_code", "unused_must_use", "expect_used", "indexing_slicing", "let_underscore_must_use",
         "panic", "print_stderr", "print_stdout", "todo", "unimplemented", "unwrap_used", "dbg_macro")

#: What each crate may depend on: dependencies go down only, and a package stays in the crate that is about it.
LAYERS = {
    "rules": {"ring", "serde_json"},
    "wire": {"httparse", "rules"},
    "pictures": {"jpeg-decoder", "jpeg-encoder", "png"},
    "files": {"pictures", "ring", "rules", "serde_json"},
    "services": {"files", "flate2", "rules", "serde_json", "ureq"},
    "server": {"files", "pictures", "rules", "serde_json", "services", "wire"},
}

_SOCKETS = [("TcpStream", "sockets"), ("TcpListener", "sockets"), ("UdpSocket", "sockets")]
_OUTSIDE = [("std::process", "processes"), ("std::env", "the environment")]
_PURE = [("std::fs", "files"), ("std::io", "input and output"), ("std::thread", "threads"), ("std::time", "the clock"),
         *_OUTSIDE, *_SOCKETS]
#: What a crate may not touch. `std::net` is not on the list as a whole: an address is a value. What it keeps out is a socket.
WORDS = {
    "rules": _PURE,
    "wire": [(word, what) for word, what in _PURE if word != "std::io"],
    "pictures": [(word, what) for word, what in _PURE if word != "std::io"],
    "files": [*_OUTSIDE, *_SOCKETS],
    "services": [*_OUTSIDE, ("TcpListener", "sockets")],
}

#: The file that builds the image.
IMAGE = "Dockerfile"

CLOCK_READS = re.compile(r"\b(SystemTime|Instant)::now\b")
CLOCK_HOME = "server/src/clock.rs"
GLOBAL_STATE = [
    (re.compile(r"\bstatic\s+mut\b"), "static mut"),
    (re.compile(r"\bstatic\s+[A-Z_0-9]+\s*:[^=]*\b(Mutex|RwLock|OnceLock|LazyLock|Atomic\w+|RefCell|Cell|Condvar)\b"),
     "a static of a lock, a cell, an atomic or a LazyLock"),
    (re.compile(r"\bthread_local!"), "thread_local!"),
    (re.compile(r"\blazy_static!"), "lazy_static!"),
]
#: A default for what is absent: nothing, zero, an empty text (its quotes are blanked to two spaces), null, false.
_NOTHING = r"(0(\.0)?|Value::Null|&?empty\w*|  |String::new\(\)|Vec::new\(\)|false|None)"
ABSENCE = re.compile(rf"\.unwrap_or_default\(\)|\.unwrap_or\({_NOTHING}\)|\.map_or\({_NOTHING},|\.unwrap_or_else\(\|\|\s*{_NOTHING}\)")
ABSENCE_REASON = "// absent-ok:"
#: A slice read within its bounds and the first piece of a split have a default that cannot happen.
NO_ABSENCE_THERE = re.compile(r"\.get(_mut)?\([^;]*\.\.|\.split\(.*\)\.next\(\)")
OWN_IMPL = re.compile(r"^impl(?:<[^>]*>)?\s+(\w+)")
FN_LINE = re.compile(r"^(\s*)(?:pub(?:\([a-z]+\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([a-z_0-9]+)")


class Source:
    """One Rust file with its comments and the insides of its strings blanked, so that braces and words count only as
    code. Lines stay where they were."""

    def __init__(self, path, crates):
        self.path = path
        self.rel = path.relative_to(crates).as_posix()
        self.crate = self.rel.split("/", 1)[0]
        self.text = path.read_text(encoding="utf-8")
        self.code = self.blanked(self.text)
        self.lines = self.code.split("\n")
        self.raw_lines = self.text.split("\n")
        self.end = self.tests_start()

    @staticmethod
    def blanked(text):
        out, at, size = [], 0, len(text)
        while at < size:
            two = text[at:at + 2]
            letter = text[at]
            if two == "//":
                stop = text.find("\n", at)
                at = size if stop < 0 else stop
            elif two == "/*":
                stop = text.find("*/", at + 2)
                stop = size if stop < 0 else stop + 2
                out.append(re.sub(r"[^\n]", " ", text[at:stop]))
                at = stop
            elif letter == '"' or (letter == "r" and re.match(r'r#*"', text[at:at + 8])
                                   and not (at and (text[at - 1].isalnum() or text[at - 1] == "_"))):
                at = Source.skip_string(text, at, out)
            elif letter == "b" and two == 'b"':
                out.append("b")
                at += 1
            elif letter == "'":
                literal = re.match(r"'(\\.[^']*|[^\\'])'", text[at:at + 12])
                if literal:
                    out.append(" " * literal.end())
                    at += literal.end()
                else:
                    out.append(letter)
                    at += 1
            else:
                out.append(letter)
                at += 1
        return "".join(out)

    @staticmethod
    def skip_string(text, at, out):
        raw = re.match(r'r(#*)"', text[at:at + 8])
        if raw:
            closing = '"' + raw.group(1)
            stop = text.find(closing, at + raw.end())
            stop = len(text) if stop < 0 else stop + len(closing)
        else:
            stop = at + 1
            while stop < len(text) and text[stop] != '"':
                stop += 2 if text[stop] == "\\" else 1
            stop = min(stop + 1, len(text))
        out.append(re.sub(r"[^\n]", " ", text[at:stop]))
        return stop

    def tests_start(self):
        """The line where the file's tests begin: the rules stop there."""
        for number, line in enumerate(self.lines):
            if line.strip() == "#[cfg(test)]":
                return number
        return len(self.lines)

    def working_lines(self):
        return list(enumerate(self.lines[:self.end]))

    def functions(self):
        """(name, line, length, column) of each function in the working part, by its braces."""
        found = []
        for number, line in self.working_lines():
            match = FN_LINE.match(line)
            if not match:
                continue
            depth, opened, at = 0, False, number
            while at < self.end:
                for letter in self.lines[at]:
                    if letter == "{":
                        depth += 1
                        opened = True
                    elif letter == "}":
                        depth -= 1
                if opened and depth <= 0:
                    break
                if not opened and self.lines[at].rstrip().endswith(";"):
                    break     # a trait's method without a body
                at += 1
            found.append((match.group(2), number + 1, at - number + 1, len(match.group(1))))
        return found


class Guard:
    """The rules, over one tree of the repository: the tests give it a small tree of their own."""

    def __init__(self, root, free=None, long=None, third_party=None, not_built=None):
        self.root = Path(root)
        self.crates = self.root / "crates"
        self.free = FREE_FUNCTIONS if free is None else free
        self.long = LONG if long is None else long
        self.third_party = THIRD_PARTY if third_party is None else third_party
        self.not_built = LOCKED_NOT_BUILT if not_built is None else not_built
        self.problems = []

    def sources(self):
        return [Source(path, self.crates) for path in sorted(self.crates.glob("*/src/**/*.rs"))]

    def check_functions(self, source):
        if source.end > FILE_LINES and source.rel not in self.long:
            self.problems.append(f"{source.rel}: {source.end} lines, the limit is {FILE_LINES}: split it by what changes for one reason, or say why in LONG")
        for name, line, length, column in source.functions():
            if length > FUNCTION_LINES and f"{source.rel}::{name}" not in self.long:
                self.problems.append(f"{source.rel}:{line}: fn {name} is {length} lines, the limit is {FUNCTION_LINES}: what does it do that is two things?")
            if column == 0 and name != "main" and name not in self.free.get(source.rel, {}):
                self.problems.append(f"{source.rel}:{line}: fn {name} stands outside an impl: objects by default, or its reason in FREE_FUNCTIONS")

    def check_own_files(self, source):
        for number, line in source.working_lines():
            match = OWN_IMPL.match(line)
            if match and match.group(1) in OWN_FILES and source.rel not in OWN_FILES[match.group(1)]:
                self.problems.append(f"{source.rel}:{number + 1}: an impl of {match.group(1)} outside its files: a rule goes to `rules`, a store to `files`, or say why in OWN_FILES")

    def check_state(self, source):
        for number, line in source.working_lines():
            for pattern, words in GLOBAL_STATE:
                if pattern.search(line):
                    self.problems.append(f"{source.rel}:{number + 1}: {words}: state is a field of an object with one owner")

    def check_words(self, source):
        for number, line in source.working_lines():
            if CLOCK_READS.search(line) and source.rel != CLOCK_HOME:
                self.problems.append(f"{source.rel}:{number + 1}: reads the clock: the clock is a parameter ({CLOCK_HOME})")
            for word, what in WORDS.get(source.crate, ()):
                if word in line:
                    self.problems.append(f"{source.rel}:{number + 1}: {source.crate} touches {what}: {word}")

    def check_absence(self, source):
        for number, line in source.working_lines():
            if not ABSENCE.search(line) or NO_ABSENCE_THERE.search(line):
                continue
            said = source.raw_lines[number] + " " + (source.raw_lines[number - 1] if number else "")
            if ABSENCE_REASON not in said:
                self.problems.append(f"{source.rel}:{number + 1}: a default stands in for what is absent: {line.strip()[:90]} — name the state, or say `{ABSENCE_REASON} why`")

    def check_unsafe(self, source):
        for number, line in source.working_lines():
            if re.search(r"\bunsafe\b", line):
                self.problems.append(f"{source.rel}:{number + 1}: unsafe: this server needs none")
            if re.search(r"#!?\[allow\(", line) and "reason" not in line:
                self.problems.append(f"{source.rel}:{number + 1}: an allow with no reason: #[allow(lint, reason = \"…\")]")

    def check_layers(self):
        for manifest in sorted(self.crates.glob("*/Cargo.toml")):
            crate = manifest.parent.name
            text = manifest.read_text(encoding="utf-8")
            section = re.search(r"^\[dependencies\]\n(.*?)(?=^\[|\Z)", text, re.M | re.S)
            names = set(re.findall(r"^([A-Za-z0-9_-]+)\s*[.=]", section.group(1), re.M)) if section else set()
            allowed = LAYERS.get(crate)
            if allowed is None:
                self.problems.append(f"crates/{crate}: a crate LAYERS does not know: say what it may depend on")
                continue
            for name in sorted(names - allowed):
                self.problems.append(f"crates/{crate}/Cargo.toml: depends on {name}, which LAYERS does not give it: dependencies go down only")
            if not re.search(r"^\[lints\]\nworkspace = true$", text, re.M):
                self.problems.append(f"crates/{crate}/Cargo.toml: does not take the workspace's lints")

    def check_third_party(self):
        lock = self.root / "Cargo.lock"
        if not lock.exists():
            self.problems.append("Cargo.lock is missing: a build would take whatever is newest")
            return
        packages = set(re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "[^"]+"\nsource = "registry', lock.read_text(encoding="utf-8")))
        if not packages:
            self.problems.append("Cargo.lock names no third-party package: this reading of it is broken")
        for name in sorted(packages - set(self.third_party) - self.not_built):
            self.problems.append(f"Cargo.lock has {name}, with no reason in THIRD_PARTY: a new package is other people's code to watch")
        for name in sorted(set(self.third_party) - packages):
            self.problems.append(f"THIRD_PARTY names {name}, which Cargo.lock no longer has: the list lies")
        told = self.root / NOT_BUILT_TOLD
        if told.exists():
            said = re.search(r"NOT_BUILT: \[&'static str; \d+\] =\s*\[([^\]]*)\]", told.read_text(encoding="utf-8"))
            names = set(re.findall(r'"([^"]+)"', said.group(1))) if said else None
            if names != self.not_built:
                self.problems.append(f"{NOT_BUILT_TOLD}: NOT_BUILT and LOCKED_NOT_BUILT differ: GET /api/packages would name what is not built, or hide what is")

    def check_lints(self):
        workspace = (self.root / "Cargo.toml").read_text(encoding="utf-8")
        for lint in LINTS:
            if not re.search(rf'^{lint} = "deny"$', workspace, re.M):
                self.problems.append(f'Cargo.toml: {lint} is not "deny"')

    def check_image(self):
        said = re.search(r'^channel = "([0-9.]+)"$', (self.root / "rust-toolchain.toml").read_text(encoding="utf-8"), re.M)
        if not said:
            self.problems.append("rust-toolchain.toml names no exact version: two builds could compile two ways")
            return
        image = self.root / IMAGE
        text = image.read_text(encoding="utf-8") if image.exists() else ""
        for version in re.findall(r"\brust:([0-9.]+[0-9])", text):
            if version != said.group(1):
                self.problems.append(f"{IMAGE}: builds with rust:{version}, rust-toolchain.toml says {said.group(1)}")
        builds = re.findall(r"cargo build[^\n]*", text)
        if not builds:
            self.problems.append(f"{IMAGE}: no `cargo build`: the image is not built from this code")
        for build in builds:
            if "--locked" not in build:
                self.problems.append(f"{IMAGE}: `{build}` without --locked: the image would take packages Cargo.lock does not name")
            if "--features" in build or "--all-features" in build or "test-upstream" in build:
                self.problems.append(f"{IMAGE}: `{build}` builds a feature: the tests' door must not be in the image")

    def run(self):
        found = self.sources()
        if not found:
            self.problems.append("crates/ holds no source: nothing is guarded")
        for source in found:
            self.check_functions(source)
            self.check_own_files(source)
            self.check_state(source)
            self.check_words(source)
            self.check_absence(source)
            self.check_unsafe(source)
        self.check_layers()
        self.check_third_party()
        self.check_lints()
        self.check_image()
        return found


def main():
    guard = Guard(Path(__file__).resolve().parent.parent)
    found = guard.run()
    if guard.problems:
        print(f"rust contract: FAILED, {len(guard.problems)}")
        for problem in guard.problems:
            print(f"  - {problem}")
        return 1
    print(f"rust contract: ok, {len(found)} files, {sum(len(source.functions()) for source in found)} functions")
    return 0


if __name__ == "__main__":
    sys.exit(main())

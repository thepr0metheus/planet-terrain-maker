//! What the running app is made of, named as osv.dev names it (`GET /api/packages`). A check of known vulnerabilities must
//! see what is installed, not what the project's files ask for: the image brings Alpine's packages, and the page carries
//! three.js and Leaflet (`web/vendor/VERSIONS.json`). Each entry is a query osv.dev answers as it is, {ecosystem, name,
//! version}, so whoever checks needs to know nothing of this app.
//!
//! Alpine's packages are named by their origin, the source package: libcrypto3 and libssl3 both come from openssl, and
//! osv.dev knows only that name. Asked by the installed names it finds nothing, which would read as "no vulnerabilities".

use files::{Locked, StoreError};
use rules::Letters;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

/// The packages of this copy of the app, read once: a running container does not change.
pub struct InstalledPackages {
    os_release: PathBuf,
    apk_database: PathBuf,
    vendor_versions: PathBuf,
    listing: Locked<Option<Value>>,
}

impl InstalledPackages {
    /// The compiled-in list of packages.
    const LOCK: &'static str = include_str!("../../../Cargo.lock");
    /// The compiler.
    const TOOLCHAIN: &'static str = include_str!("../../../rust-toolchain.toml");
    /// Named in `Cargo.lock` and never built: serde_json and serde hold each other's versions in step under a
    /// `cfg(any())`, a target that never is; the windows and wasi crates are of other systems; zlib-rs is a way of flate2
    /// not taken. `tools/check_rust_contract.py` holds this list to its own.
    const NOT_BUILT: [&'static str; 18] = [
        "serde",
        "serde_derive",
        "proc-macro2",
        "quote",
        "syn",
        "unicode-ident",
        "zlib-rs",
        "wasi",
        "windows-sys",
        "windows-targets",
        "windows_aarch64_gnullvm",
        "windows_aarch64_msvc",
        "windows_i686_gnu",
        "windows_i686_gnullvm",
        "windows_i686_msvc",
        "windows_x86_64_gnu",
        "windows_x86_64_gnullvm",
        "windows_x86_64_msvc",
    ];

    /// The list of a service on a system described by these files, with the page's libraries in this one.
    pub fn new(os_release: PathBuf, apk_database: PathBuf, vendor_versions: PathBuf) -> Self {
        Self { os_release, apk_database, vendor_versions, listing: Locked::new(None) }
    }

    /// `{runtime, os, packages}`. `os` is null when the system cannot be told, and `os.listed` is false when its packages
    /// cannot be read: then a check must say it did not see them. No file of the page's versions is no listing, not an
    /// empty one: the error goes out, and the check fails aloud.
    pub fn listing(&self) -> Result<Value, StoreError> {
        self.listing.with(|listing| {
            if let Some(known) = listing {
                return Ok(known.clone());
            }
            let read = self.read()?;
            *listing = Some(read.clone());
            Ok(read)
        })
    }

    fn read(&self) -> Result<Value, StoreError> {
        let system = self.system();
        let alpine = system.as_ref().and_then(|(name, version)| self.alpine(name, version));
        let os = system.map(|(name, version)| json!({"name": name, "version": version, "listed": alpine.is_some()}));
        let mut packages = Self::crates();
        packages.extend(self.page()?);
        packages.extend(alpine.into_iter().flatten());
        Ok(json!({"runtime": {"name": "rust", "version": Self::compiler()}, "os": os, "packages": packages}))
    }

    /// The version `rust-toolchain.toml` names: the one the image builds with, as the guard holds.
    fn compiler() -> &'static str {
        let said = Self::TOOLCHAIN.lines().find_map(|line| line.trim().strip_prefix("channel"));
        said.map_or("unknown", |value| value.trim().trim_start_matches('=').trim().trim_matches('"'))
    }

    /// The third-party crates of the build, each once, by name and version.
    fn crates() -> Vec<Value> {
        let mut found = BTreeSet::new();
        for record in Self::LOCK.split("[[package]]").skip(1) {
            let field = |key: &str| {
                record.lines().find_map(|line| line.strip_prefix(key)?.strip_prefix(" = \"")?.strip_suffix('"'))
            };
            if let (Some(name), Some(version), Some(_)) = (field("name"), field("version"), field("source"))
                && !Self::NOT_BUILT.contains(&name)
            {
                found.insert((name, version));
            }
        }
        found
            .into_iter()
            .map(|(name, version)| json!({"ecosystem": "crates.io", "name": name, "version": version}))
            .collect()
    }

    fn page(&self) -> Result<Vec<Value>, StoreError> {
        let bytes = fs::read(&self.vendor_versions)?;
        let versions: Value = serde_json::from_slice(&bytes)
            .map_err(|error| StoreError::failed(format!("{}: {error}", self.vendor_versions.display())))?;
        let Some(versions) = versions.as_object() else {
            return Err(StoreError::failed(format!("{}: no table of versions", self.vendor_versions.display())));
        };
        let mut pairs: Vec<(&String, &Value)> = versions.iter().collect();
        pairs.sort_by_key(|(name, _)| *name);
        Ok(pairs
            .into_iter()
            .map(|(name, version)| json!({"ecosystem": "npm", "name": name, "version": version}))
            .collect())
    }

    /// (`ID`, `VERSION_ID`) of `os-release`; `None` when the system cannot be told.
    fn system(&self) -> Option<(String, String)> {
        let text = fs::read_to_string(&self.os_release).ok()?;
        let field = |key: &str| {
            text.lines()
                .filter_map(|line| line.split_once('='))
                .rfind(|(name, _)| Letters::strip(name) == key)
                .map(|(_, value)| Letters::strip(value).trim_matches(['"', '\'']).to_string())
        };
        let name = field("ID").filter(|name| !name.is_empty())?;
        // absent-ok: a system that says no version has none: `listed` is then false.
        Some((name, field("VERSION_ID").unwrap_or_default()))
    }

    /// Alpine's packages by their source package; `None` for a system whose packages cannot be read.
    fn alpine(&self, name: &str, version: &str) -> Option<Vec<Value>> {
        let mut pieces = version.split('.');
        let (major, minor) = (pieces.next()?, pieces.next()?);
        if name != "alpine"
            || !Letters::is_digits(major)
            || !minor.bytes().next().is_some_and(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let bytes = fs::read(&self.apk_database).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let ecosystem = format!("Alpine:v{major}.{minor}");
        let mut found = BTreeSet::new();
        for record in text.split("\n\n") {
            let field = |key: &str| record.lines().find_map(|line| line.strip_prefix(key)?.strip_prefix(':'));
            if let (Some(name), Some(version)) = (field("o").or_else(|| field("P")), field("V")) {
                found.insert((name, version));
            }
        }
        Some(
            found
                .into_iter()
                .map(|(name, version)| json!({"ecosystem": ecosystem, "name": name, "version": version}))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three records of Alpine's database of installed packages, as apk writes it.
    const APK: &str = "C:Q1abc=\nP:libcrypto3\nV:3.5.4-r0\nA:x86_64\no:openssl\nF:usr/lib\nR:libcrypto.so.3\na:0:0:755\n\nC:Q1def=\nP:libssl3\nV:3.5.4-r0\no:openssl\n\nP:musl\nV:1.2.5-r10\no:musl\n";

    struct System {
        root: PathBuf,
    }

    impl System {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("ptm-packages-{name}-{}", std::process::id()));
            drop(fs::remove_dir_all(&root));
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("VERSIONS.json"), r#"{"three": "0.186.1", "leaflet": "1.9.4"}"#).unwrap();
            Self { root }
        }

        fn write(&self, file: &str, text: &str) {
            fs::write(self.root.join(file), text).unwrap();
        }

        fn listing(&self) -> Value {
            let packages = InstalledPackages::new(
                self.root.join("os-release"),
                self.root.join("installed"),
                self.root.join("VERSIONS.json"),
            );
            packages.listing().unwrap()
        }
    }

    impl Drop for System {
        fn drop(&mut self) {
            drop(fs::remove_dir_all(&self.root));
        }
    }

    fn of(listing: &Value, start: &str) -> Vec<Value> {
        let packages = listing["packages"].as_array().unwrap();
        packages.iter().filter(|package| package["ecosystem"].as_str().unwrap().starts_with(start)).cloned().collect()
    }

    #[test]
    fn alpine_packages_go_by_their_source_once() {
        let system = System::new("alpine");
        system.write("os-release", "NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.22.2\n");
        system.write("installed", APK);
        let listing = system.listing();
        assert_eq!(listing["os"], json!({"name": "alpine", "version": "3.22.2", "listed": true}));
        assert_eq!(
            of(&listing, "Alpine"),
            [
                json!({"ecosystem": "Alpine:v3.22", "name": "musl", "version": "1.2.5-r10"}),
                json!({"ecosystem": "Alpine:v3.22", "name": "openssl", "version": "3.5.4-r0"})
            ]
        );
    }

    #[test]
    fn a_system_it_cannot_list_is_said_and_not_shown_as_empty() {
        let system = System::new("debian");
        system.write("os-release", "ID=debian\nVERSION_ID=\"12\"\n");
        let listing = system.listing();
        assert_eq!(listing["os"], json!({"name": "debian", "version": "12", "listed": false}));
        assert!(of(&listing, "Alpine").is_empty());
        let unread = System::new("unread");
        unread.write("os-release", "ID=alpine\nVERSION_ID=3.22.2\n");
        assert_eq!(unread.listing()["os"]["listed"], false);
        assert_eq!(System::new("none").listing()["os"], Value::Null);
    }

    #[test]
    fn the_page_libraries_the_crates_and_the_compiler_are_listed() {
        let listing = System::new("page").listing();
        assert_eq!(listing["runtime"]["name"], "rust");
        assert!(listing["runtime"]["version"].as_str().unwrap().starts_with("1."), "{listing}");
        assert_eq!(
            of(&listing, "npm"),
            [
                json!({"ecosystem": "npm", "name": "leaflet", "version": "1.9.4"}),
                json!({"ecosystem": "npm", "name": "three", "version": "0.186.1"})
            ]
        );
        let crates = of(&listing, "crates.io");
        let names: Vec<&str> = crates.iter().map(|package| package["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"serde_json") && names.contains(&"ureq"), "{names:?}");
        assert!(!names.contains(&"files"), "our own are not packages");
        assert!(!names.contains(&"syn") && !names.contains(&"windows-sys"), "named in the lock and never built");
    }

    #[test]
    fn no_file_of_the_page_s_versions_is_no_listing() {
        let system = System::new("no-versions");
        fs::remove_file(system.root.join("VERSIONS.json")).unwrap();
        let packages = InstalledPackages::new(
            system.root.join("os-release"),
            system.root.join("installed"),
            system.root.join("VERSIONS.json"),
        );
        assert!(packages.listing().is_err());
    }
}

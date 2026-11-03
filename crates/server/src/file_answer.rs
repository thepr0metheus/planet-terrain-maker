//! A file as an answer: the page's own, or one of a model.

use crate::answer::{Answer, Body};
use crate::failure::Failure;
use files::StoreError;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The types of the files there are. Anything else goes as plain bytes.
pub struct FileAnswer;

impl FileAnswer {
    const TYPES: [(&'static str, &'static str); 10] = [
        ("html", "text/html"),
        ("css", "text/css"),
        ("js", "text/javascript"),
        ("mjs", "text/javascript"),
        ("json", "application/json"),
        ("svg", "image/svg+xml"),
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("md", "text/markdown"),
        ("txt", "text/plain"),
    ];
    const BYTES: &'static str = "application/octet-stream";

    /// The type of this file, by its name.
    fn mimetype_of(path: &Path) -> &'static str {
        let ending = path.extension().and_then(|ending| ending.to_str()).map(str::to_lowercase);
        let known = Self::TYPES.iter().find(|(known, _)| Some(*known) == ending.as_deref());
        known.map_or(Self::BYTES, |(_, mimetype)| *mimetype)
    }

    /// The file a path names under `root`; `None` for what is not a file there. What `..` leads out of the folder is not
    /// there.
    pub fn under(root: &Path, path: &str) -> Option<PathBuf> {
        let root = root.canonicalize().ok()?;
        let file = root.join(path).canonicalize().ok()?;
        (file.starts_with(&root) && file.is_file()).then_some(file)
    }

    /// The file, or "you have it": `if_none_match` is what the request says it has. A browser asks again each time
    /// (no-cache), and gets "not modified" until the file changes.
    pub fn of(path: &Path, if_none_match: Option<&str>) -> Result<Answer, Failure> {
        let file = File::open(path).map_err(Self::store)?;
        let meta = file.metadata().map_err(Self::store)?;
        let tag = Self::tag(&meta);
        // absent-ok: a path with no name has none to say, and nothing here serves one.
        let name = path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default().into_owned();
        let fields = Answer::empty(200).cached(Answer::NO_CACHE).field("ETag", tag.clone());
        if if_none_match.is_some_and(|said| Self::names(said, &tag)) {
            return Ok(Answer { status: 304, ..fields });
        }
        Ok(Answer {
            kind: Some(Answer::kind_of(Self::mimetype_of(path))),
            body: Body::File(file, meta.len()),
            ..fields.field("Content-Disposition", format!("inline; filename={name}"))
        })
    }

    fn store(error: io::Error) -> Failure {
        StoreError::from(error).into()
    }

    /// Changes when the file does.
    fn tag(meta: &fs::Metadata) -> String {
        let modified = meta.modified().ok().and_then(|moment| moment.duration_since(UNIX_EPOCH).ok());
        // absent-ok: a file with no date has only its size to tell it by.
        let nanos = modified.map_or(0, |since| since.as_nanos());
        format!("\"{nanos:x}-{:x}\"", meta.len())
    }

    /// Whether `If-None-Match` names this tag: one of a list, weak or strong, or `*`.
    fn names(said: &str, tag: &str) -> bool {
        said.split(',').map(str::trim).any(|part| part == "*" || part.strip_prefix("W/").unwrap_or(part) == tag)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_types_of_files() {
        for (name, want) in [
            ("a.js", "text/javascript"),
            ("a.JSON", "application/json"),
            ("LICENSE", "application/octet-stream"),
            ("place-0.bin", "application/octet-stream"),
            ("thumb.jpg", "image/jpeg"),
            ("favicon.svg", "image/svg+xml"),
        ] {
            assert_eq!(FileAnswer::mimetype_of(Path::new(name)), want, "{name}");
        }
    }

    #[test]
    fn what_a_browser_says_it_has() {
        let tag = "\"a-1\"";
        for said in ["\"a-1\"", "W/\"a-1\"", "\"b\", \"a-1\"", "*"] {
            assert!(FileAnswer::names(said, tag), "{said}");
        }
        assert!(!FileAnswer::names("\"b\"", tag));
    }

    #[test]
    fn nothing_outside_its_folder() {
        let root = std::env::temp_dir().join(format!("ptm-web-{}", std::process::id()));
        fs::create_dir_all(root.join("web/js")).unwrap();
        fs::write(root.join("web/js/app.js"), "x").unwrap();
        fs::write(root.join("VERSION"), "x").unwrap();
        let web = root.join("web");
        assert!(FileAnswer::under(&web, "js/app.js").is_some());
        assert!(FileAnswer::under(&web, "js").is_none(), "a folder is no file");
        assert!(FileAnswer::under(&web, "nothing").is_none());
        assert!(FileAnswer::under(&web, "../VERSION").is_none());
        assert!(FileAnswer::under(&web, "js/../../VERSION").is_none());
        fs::remove_dir_all(root).unwrap();
    }
}

//! What a route answers.

use crate::failure::Failure;
use rules::JsonForm;
use serde_json::Value;
use std::fs::File;

/// What a route does with a request: its answer, or the failure answered for it.
pub type Handled = Result<Answer, Failure>;

/// What goes after the head.
#[derive(Debug)]
pub enum Body {
    /// Nothing.
    Empty,
    /// These bytes.
    Bytes(Vec<u8>),
    /// A file, sent as it is read: a model's heights can take 96 MB.
    File(File, u64),
}

/// An answer, whole, before it goes to the wire: a route makes it, and `Exchange` says how it travels.
#[derive(Debug)]
pub struct Answer {
    /// The status.
    pub status: u16,
    /// The type of its content, whole, with its encoding; none for no content.
    pub kind: Option<String>,
    /// The body.
    pub body: Body,
    /// The other fields.
    pub fields: Vec<(&'static str, String)>,
}

impl Answer {
    /// Built-in sources come through this server. The 3D model's custom picture tiles are read directly over HTTPS, with
    /// CORS, so their URL never becomes a server-side fetch target. `connect-src blob:` lets the page read what it made
    /// itself: GLTFLoader reads a model's pictures from blobs.
    pub const PAGE_POLICY: &'static str = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    /// What does not change: a tile, a shape.
    pub const KEPT_LONG: &'static str = "public, max-age=2592000, immutable";
    /// Kept, and asked about again each time.
    pub const NO_CACHE: &'static str = "no-cache";

    /// An answer of this type of content, whole, with these bytes.
    pub fn bytes(status: u16, kind: impl Into<String>, body: Vec<u8>) -> Self {
        Self { status, kind: Some(kind.into()), body: Body::Bytes(body), fields: Vec::new() }
    }

    /// JSON: compact, keys sorted, letters as they stand, and a line end.
    pub fn json(status: u16, payload: &Value) -> Self {
        Self::bytes(status, "application/json", format!("{}\n", JsonForm::ANSWER.write(payload)).into_bytes())
    }

    /// No content.
    pub fn empty(status: u16) -> Self {
        Self { status, kind: None, body: Body::Empty, fields: Vec::new() }
    }

    /// One field more.
    #[must_use]
    pub fn field(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.fields.push((name, value.into()));
        self
    }

    /// How it may be kept.
    #[must_use]
    pub fn cached(self, how: &'static str) -> Self {
        self.field("Cache-Control", how)
    }

    /// The type of content a type goes out as: a text says its encoding.
    pub fn kind_of(mimetype: &str) -> String {
        let is_text = mimetype.starts_with("text/") || mimetype.ends_with("+xml");
        if is_text { format!("{mimetype}; charset=utf-8") } else { mimetype.to_string() }
    }

    /// The page of a status the request itself earned, in the words it always had.
    pub fn page_of(status: u16) -> Self {
        let (title, words) = match status {
            400 => ("Bad Request", "The browser (or proxy) sent a request that this server could not understand."),
            404 => (
                "Not Found",
                "The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.",
            ),
            405 => ("Method Not Allowed", "The method is not allowed for the requested URL."),
            411 => {
                ("Length Required", "A request with this method requires a valid <code>Content-Length</code> header.")
            }
            413 => ("Request Entity Too Large", "The data value transmitted exceeds the capacity limit."),
            _ => (
                "Internal Server Error",
                "The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.",
            ),
        };
        let page = format!(
            "<!doctype html>\n<html lang=en>\n<title>{status} {title}</title>\n<h1>{title}</h1>\n<p>{words}</p>\n"
        );
        Self::bytes(status, Self::kind_of("text/html"), page.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_is_written_as_flask_wrote_it() {
        let answer = Answer::json(200, &json!({"b": 1, "a": "ა"}));
        let Body::Bytes(body) = answer.body else {
            panic!("no bytes");
        };
        assert_eq!(body, "{\"a\":\"ა\",\"b\":1}\n".as_bytes());
        assert_eq!(answer.kind.as_deref(), Some("application/json"));
    }

    #[test]
    fn a_text_says_its_encoding() {
        for (mimetype, want) in [
            ("text/plain", "text/plain; charset=utf-8"),
            ("image/svg+xml", "image/svg+xml; charset=utf-8"),
            ("model/gltf-binary", "model/gltf-binary"),
            ("image/jpeg", "image/jpeg"),
        ] {
            assert_eq!(Answer::kind_of(mimetype), want);
        }
    }

    #[test]
    fn a_page_of_a_status() {
        let answer = Answer::page_of(404);
        assert_eq!(answer.kind.as_deref(), Some("text/html; charset=utf-8"));
        let Body::Bytes(body) = answer.body else {
            panic!("no bytes");
        };
        assert!(String::from_utf8(body).unwrap().contains("<title>404 Not Found</title>"));
    }
}

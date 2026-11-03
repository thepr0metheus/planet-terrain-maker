//! A request's head off the wire.

use crate::headers::Headers;
use std::io::{self, BufRead, Read as _};

/// Why a head could not be read.
#[derive(Debug)]
pub enum HeadError {
    /// The peer closed the connection before a whole head; before its first byte, nothing was asked.
    Closed,
    /// The socket failed, or waited past its time.
    Io(io::Error),
    /// The bytes are not an HTTP request; the words say why.
    Malformed(String),
}

/// The request line and the fields of one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestHead {
    /// `GET`, `POST`…
    pub method: String,
    /// The target as sent: the path and the query.
    pub target: String,
    /// The fields.
    pub headers: Headers,
    /// The `1` of `HTTP/1.1`.
    pub minor: u8,
}

impl RequestHead {
    /// The most bytes a head may take, all of it.
    const LIMIT: usize = 262_144;
    /// The most fields a head may carry.
    const FIELDS: usize = 128;

    /// Reads one head and leaves the body unread in `source`.
    pub fn read(source: &mut impl BufRead) -> Result<Self, HeadError> {
        let raw = Self::raw_head(source)?;
        let mut slots = [httparse::EMPTY_HEADER; Self::FIELDS];
        let mut parsed = httparse::Request::new(&mut slots);
        match parsed.parse(&raw) {
            Ok(httparse::Status::Complete(_)) => {}
            Ok(httparse::Status::Partial) => return Err(HeadError::Malformed("the head ended too early".into())),
            Err(error) => return Err(HeadError::Malformed(error.to_string())),
        }
        let (Some(method), Some(target)) = (parsed.method, parsed.path) else {
            return Err(HeadError::Malformed("no request line".into()));
        };
        let mut headers = Headers::new();
        for field in parsed.headers.iter() {
            headers.push(field.name, field.value);
        }
        // absent-ok: a complete parse has a version; a head without one reads as the older, whose connection closes.
        let minor = parsed.version.unwrap_or_default();
        Ok(Self { method: method.to_string(), target: target.to_string(), headers, minor })
    }

    /// The head's bytes up to its blank line, the line included. A line at a time, so that not a byte of the body is taken.
    fn raw_head(source: &mut impl BufRead) -> Result<Vec<u8>, HeadError> {
        let mut raw = Vec::with_capacity(1024);
        loop {
            let before = raw.len();
            let budget = (Self::LIMIT + 1 - before) as u64;
            let read = source.by_ref().take(budget).read_until(b'\n', &mut raw).map_err(HeadError::Io)?;
            if raw.len() > Self::LIMIT {
                return Err(HeadError::Malformed("the head is too long".into()));
            }
            if read == 0 {
                return Err(if raw.is_empty() {
                    HeadError::Closed
                } else {
                    HeadError::Malformed("the head ended too early".into())
                });
            }
            let line = raw.get(before..).unwrap_or_default();
            if line == b"\r\n" || line == b"\n" {
                if before == 0 {
                    // A blank line before the request line is allowed by RFC 9112 2.2, and skipped.
                    raw.clear();
                    continue;
                }
                return Ok(raw);
            }
        }
    }

    /// Whether the connection stays open after this request: HTTP/1.1 keeps it unless told otherwise, HTTP/1.0 closes
    /// it unless told otherwise.
    pub fn keeps_alive(&self) -> bool {
        match self.headers.get("Connection").map(|value| value.to_lowercase()).as_deref() {
            Some("close") => false,
            Some("keep-alive") => true,
            _ => self.minor >= 1,
        }
    }

    /// Whether the client waits for a word before it sends a body.
    pub fn expects_continue(&self) -> bool {
        self.minor >= 1 && self.headers.get("Expect").is_some_and(|value| value.eq_ignore_ascii_case("100-continue"))
    }

    /// The target's path, without its query and fragment, undecoded.
    pub fn path(&self) -> &str {
        self.target.split(['?', '#']).next().unwrap_or_default()
    }

    /// The target's query, without its `?` and fragment: "" when there is none.
    pub fn query(&self) -> &str {
        let before_fragment = self.target.split('#').next().unwrap_or_default();
        // absent-ok: a target with no `?` has no query.
        before_fragment.split_once('?').map_or("", |(_, query)| query)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor, Read};

    fn head_of(text: &[u8]) -> Result<RequestHead, HeadError> {
        RequestHead::read(&mut BufReader::new(Cursor::new(text.to_vec())))
    }

    #[test]
    fn reads_the_line_and_the_fields_as_they_came() {
        let head = head_of(b"POST /api/models?x=1 HTTP/1.1\r\nHost: a\r\nX-Two: 1\r\nx-two: 2\r\n\r\nbody").unwrap();
        assert_eq!(head.method, "POST");
        assert_eq!(head.target, "/api/models?x=1");
        assert_eq!(head.path(), "/api/models");
        assert_eq!(head.query(), "x=1");
        assert_eq!(head.headers.get("HOST").as_deref(), Some("a"));
        assert_eq!(head.headers.get("x-two").as_deref(), Some("1"));
    }

    #[test]
    fn a_connection_stays_or_goes_as_the_head_says() {
        for (head, stays) in [
            ("GET / HTTP/1.1\r\n\r\n", true),
            ("GET / HTTP/1.0\r\n\r\n", false),
            ("GET / HTTP/1.1\r\nConnection: Close\r\n\r\n", false),
            ("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n", true),
        ] {
            assert_eq!(head_of(head.as_bytes()).unwrap().keeps_alive(), stays, "{head}");
        }
        assert!(head_of(b"PUT / HTTP/1.1\r\nExpect: 100-Continue\r\n\r\n").unwrap().expects_continue());
        assert!(!head_of(b"PUT / HTTP/1.0\r\nExpect: 100-Continue\r\n\r\n").unwrap().expects_continue());
    }

    #[test]
    fn a_fragment_is_neither_path_nor_query() {
        let head = head_of(b"GET /a?b=1#c HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!((head.path(), head.query()), ("/a", "b=1"));
        assert_eq!(head_of(b"GET /a#c?d HTTP/1.1\r\n\r\n").unwrap().query(), "");
    }

    #[test]
    fn leaves_the_body_unread() {
        let mut source = BufReader::new(Cursor::new(b"GET / HTTP/1.1\r\n\r\nbody".to_vec()));
        RequestHead::read(&mut source).unwrap();
        let mut rest = String::new();
        source.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "body");
    }

    #[test]
    fn a_closed_connection_and_a_cut_head_are_two_answers() {
        assert!(matches!(head_of(b""), Err(HeadError::Closed)));
        assert!(matches!(head_of(b"GET / HTTP/1.1\r\nHost"), Err(HeadError::Malformed(_))));
        assert!(matches!(head_of(b"not http\r\n\r\n"), Err(HeadError::Malformed(_))));
        assert!(matches!(head_of(b"\x16\x03\x01 not http at all\r\n\r\n"), Err(HeadError::Malformed(_))));
    }

    #[test]
    fn a_blank_line_before_the_request_is_skipped() {
        assert_eq!(head_of(b"\r\nGET /x HTTP/1.1\r\n\r\n").unwrap().target, "/x");
    }

    #[test]
    fn a_head_past_its_limits_is_refused() {
        let mut long = b"GET / HTTP/1.1\r\nX-Long: ".to_vec();
        long.extend(std::iter::repeat_n(b'x', 262_144));
        long.extend_from_slice(b"\r\n\r\n");
        assert!(matches!(head_of(&long), Err(HeadError::Malformed(words)) if words == "the head is too long"));
        let mut endless = b"GET / HTTP/1.1\r\nX-Long: ".to_vec();
        endless.extend(std::iter::repeat_n(b'x', 1_000_000));
        assert!(
            matches!(head_of(&endless), Err(HeadError::Malformed(words)) if words == "the head is too long"),
            "no line end"
        );
        let mut many = b"GET / HTTP/1.1\r\n".to_vec();
        for at in 0..200 {
            many.extend_from_slice(format!("X-{at}: value\r\n").as_bytes());
        }
        many.extend_from_slice(b"\r\n");
        assert!(matches!(head_of(&many), Err(HeadError::Malformed(_))));
    }
}

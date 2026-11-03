//! A reply's head, as bytes.

use crate::headers::Headers;

/// A status line and fields to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    status: u16,
    headers: Headers,
}

impl Reply {
    /// A reply of `status`.
    pub fn new(status: u16) -> Self {
        Self { status, headers: Headers::new() }
    }

    /// Adds a field.
    #[must_use]
    pub fn field(mut self, name: &str, value: impl Into<Vec<u8>>) -> Self {
        self.headers.push(name, value);
        self
    }

    /// The head's bytes, its blank line included. A value that carries a line end would let what it quotes write a
    /// field of its own: such a field goes without its line ends.
    pub fn head(&self) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, Self::standard_reason(self.status)).into_bytes();
        for field in self.headers.iter() {
            out.extend(field.name.bytes().filter(|byte| !matches!(byte, b'\r' | b'\n')));
            out.extend_from_slice(b": ");
            out.extend(field.value.iter().filter(|byte| !matches!(byte, b'\r' | b'\n')));
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        out
    }

    /// The words of a status; "" for one this table has not.
    fn standard_reason(status: u16) -> &'static str {
        match status {
            200 => "OK",
            201 => "Created",
            204 => "No Content",
            304 => "Not Modified",
            400 => "Bad Request",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            411 => "Length Required",
            413 => "Request Entity Too Large",
            415 => "Unsupported Media Type",
            429 => "Too Many Requests",
            500 => "Internal Server Error",
            502 => "Bad Gateway",
            503 => "Service Unavailable",
            _ => "",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_head_is_a_status_line_and_its_fields() {
        let head = Reply::new(503).field("Content-Length", "2").field("X-Bytes", vec![0xE9]).head();
        assert_eq!(head, b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\nX-Bytes: \xE9\r\n\r\n");
    }

    #[test]
    fn a_value_cannot_write_a_field_of_its_own() {
        let head = Reply::new(200).field("X-Y", "a\r\nEvil: 2").head();
        assert_eq!(head, b"HTTP/1.1 200 OK\r\nX-Y: aEvil: 2\r\n\r\n");
    }

    #[test]
    fn a_status_this_table_has_not_goes_without_words() {
        assert_eq!(Reply::new(299).head(), b"HTTP/1.1 299 \r\n\r\n");
    }
}

//! A multipart/form-data body, as browsers send it: the parts lie in one buffer, and are not copied.

use rules::{Letters, Percent};

/// One part of a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part<'a> {
    /// Its field's name.
    pub name: String,
    /// Whether it is a file: its head names a `filename`, an empty one too.
    pub is_file: bool,
    /// Its bytes.
    pub body: &'a [u8],
}

/// Why a body gave no parts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultipartError {
    /// It is cut short, or not made as it says: a body that cannot be read counts as one that says nothing.
    Unreadable,
    /// It has more parts than may be read.
    TooMany,
}

/// The reading of a multipart body.
pub struct Multipart;

impl Multipart {
    /// The boundary a `Content-Type` of `multipart/form-data` names; `None` for another type, or one that names none.
    pub fn boundary_of(content_type: &str) -> Option<String> {
        let (kind, parameters) = content_type.split_once(';')?;
        if !Letters::strip(kind).eq_ignore_ascii_case("multipart/form-data") {
            return None;
        }
        Self::parameter(parameters, "boundary").filter(|boundary| !boundary.is_empty())
    }

    /// The parts of this body, in their order, at most `most` of them. A part with no name of a field is left out.
    pub fn parts<'a>(body: &'a [u8], boundary: &str, most: usize) -> Result<Vec<Part<'a>>, MultipartError> {
        let mark = format!("--{boundary}").into_bytes();
        let unreadable = MultipartError::Unreadable;
        let (_, mut last, mut at) = Self::next_mark(body, &mark, 0).ok_or(unreadable)?;
        let mut parts = Vec::new();
        while !last {
            if parts.len() == most {
                return Err(MultipartError::TooMany);
            }
            let (head, blank) = Self::split_head(body.get(at..).ok_or(unreadable)?).ok_or(unreadable)?;
            let content = at + head + blank;
            let (end, closing, next) = Self::next_mark(body, &mark, content).ok_or(unreadable)?;
            let (raw_head, content) = (body.get(at..at + head), body.get(content..end));
            if let Some(part) = Self::part(raw_head.ok_or(unreadable)?, content.ok_or(unreadable)?) {
                parts.push(part);
            }
            (last, at) = (closing, next);
        }
        Ok(parts)
    }

    /// The next line that is the boundary, from `from`: where what comes before it ends (its line end left out),
    /// whether it is the closing one, and where the next part's head starts.
    fn next_mark(body: &[u8], mark: &[u8], from: usize) -> Option<(usize, bool, usize)> {
        let mut search = from;
        loop {
            let found = search + body.get(search..)?.windows(mark.len()).position(|window| window == mark)?;
            let starts_a_line = found == 0 || found == from || body.get(found - 1) == Some(&b'\n');
            if starts_a_line && let Some((last, next)) = Self::after_mark(body, found + mark.len()) {
                return Some((Self::end_before_line_break(body, found, from), last, next));
            }
            search = found + 1;
        }
    }

    /// What follows a boundary's mark: `--` closes the body, and otherwise a line end after any spaces must come.
    fn after_mark(body: &[u8], at: usize) -> Option<(bool, usize)> {
        let last = body.get(at..at + 2) == Some(b"--");
        let mut after = if last { at + 2 } else { at };
        while matches!(body.get(after), Some(b' ' | b'\t')) {
            after += 1;
        }
        match body.get(after) {
            Some(b'\r') if body.get(after + 1) == Some(&b'\n') => Some((last, after + 2)),
            Some(b'\n' | b'\r') => Some((last, after + 1)),
            None if last => Some((last, after)),
            _ => None,
        }
    }

    fn end_before_line_break(body: &[u8], found: usize, from: usize) -> usize {
        let before = |back: usize| found.checked_sub(back).filter(|at| *at >= from).and_then(|at| body.get(at));
        match (before(2), before(1)) {
            (Some(b'\r'), Some(b'\n')) => found - 2,
            (_, Some(b'\n' | b'\r')) => found - 1,
            _ => found,
        }
    }

    /// The length of a part's head, and of the blank line that ends it.
    fn split_head(rest: &[u8]) -> Option<(usize, usize)> {
        if rest.starts_with(b"\r\n") {
            return Some((0, 2));
        }
        if rest.starts_with(b"\n") {
            return Some((0, 1));
        }
        for (at, window) in rest.windows(2).enumerate() {
            if window == b"\n\n" {
                return Some((at + 1, 1));
            }
            if window == b"\n\r" && rest.get(at + 2) == Some(&b'\n') {
                return Some((at + 1, 2));
            }
        }
        None
    }

    fn part<'a>(raw_head: &[u8], body: &'a [u8]) -> Option<Part<'a>> {
        let head = String::from_utf8_lossy(raw_head);
        let disposition = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            Letters::strip(name).eq_ignore_ascii_case("content-disposition").then_some(value)
        })?;
        let (_, parameters) = disposition.split_once(';')?;
        let name = Self::parameter(parameters, "name")?;
        let is_file = Self::parameter(parameters, "filename").is_some();
        Some(Part { name, is_file, body })
    }

    /// The value of a parameter in `; a=b; c="d"`. A quoted value may hold `;`, and `\"`.
    fn parameter(parameters: &str, wanted: &str) -> Option<String> {
        let mut rest = parameters;
        loop {
            rest = rest.trim_start_matches(|letter: char| Letters::is_space(letter) || letter == ';');
            if rest.is_empty() {
                return None;
            }
            let (name, after) = rest.split_once('=')?;
            let (value, after) = Self::parameter_value(after);
            if Letters::strip(name).eq_ignore_ascii_case(wanted) {
                return Some(value);
            }
            rest = after;
        }
    }

    /// A value and what comes after it. A browser writes `"` in a value as `%22`, which is read back.
    fn parameter_value(text: &str) -> (String, &str) {
        let Some(quoted) = text.strip_prefix('"') else {
            let end = text.find(';').unwrap_or(text.len());
            let (value, after) = text.split_at(end);
            return (Letters::strip(value).to_string(), after);
        };
        let mut value = String::new();
        let mut letters = quoted.char_indices();
        while let Some((at, letter)) = letters.next() {
            match letter {
                '"' => return (Self::unescaped(&value), quoted.get(at + 1..).unwrap_or("")),
                '\\' => {
                    if let Some((_, next)) = letters.next() {
                        value.push(next);
                    }
                }
                other => value.push(other),
            }
        }
        (Self::unescaped(&value), "")
    }

    fn unescaped(value: &str) -> String {
        if value.contains("%22") || value.contains("%0A") || value.contains("%0D") {
            value.replace("%22", &Percent::decode("%22")).replace("%0A", "\n").replace("%0D", "\r")
        } else {
            value.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &[u8] = b"--x\r\nContent-Disposition: form-data; name=\"meta\"\r\n\r\n{\"name\": \"a\"}\r\n\
        --x\r\nContent-Disposition: form-data; name=\"place-0.bin\"; filename=\"place-0.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n\0\r\n--y\xff\r\n\
        --x--\r\n";

    #[test]
    fn the_boundary_of_a_type() {
        assert_eq!(Multipart::boundary_of("multipart/form-data; boundary=abc").as_deref(), Some("abc"));
        assert_eq!(Multipart::boundary_of("Multipart/Form-Data; charset=x; BOUNDARY=\"a b\"").as_deref(), Some("a b"));
        assert_eq!(Multipart::boundary_of("multipart/form-data"), None);
        assert_eq!(Multipart::boundary_of("multipart/form-data; boundary="), None);
        assert_eq!(Multipart::boundary_of("application/json; boundary=abc"), None);
    }

    #[test]
    fn fields_and_files_with_any_bytes_in_them() {
        let parts = Multipart::parts(BODY, "x", 9).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(
            (parts[0].name.as_str(), parts[0].is_file, parts[0].body),
            ("meta", false, &b"{\"name\": \"a\"}"[..])
        );
        assert_eq!(
            (parts[1].name.as_str(), parts[1].is_file, parts[1].body),
            ("place-0.bin", true, &b"\0\r\n--y\xff"[..])
        );
    }

    #[test]
    fn a_mark_inside_a_line_is_no_mark() {
        let body = b"--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nb--x\r\nc\r\n--xy\r\nd\r\n--x--";
        let parts = Multipart::parts(body, "x", 9).unwrap();
        assert_eq!(parts[0].body, b"b--x\r\nc\r\n--xy\r\nd");
    }

    #[test]
    fn an_empty_part_and_no_parts() {
        let body = b"--x\r\nContent-Disposition: form-data; name=\"a\"; filename=\"\"\r\n\r\n\r\n--x--\r\n";
        let parts = Multipart::parts(body, "x", 9).unwrap();
        assert_eq!((parts[0].is_file, parts[0].body), (true, &b""[..]));
        assert_eq!(Multipart::parts(b"--x--\r\n", "x", 9).unwrap(), []);
    }

    #[test]
    fn line_ends_of_one_letter() {
        let body = b"--x\nContent-Disposition: form-data; name=\"a\"\n\nb\n--x--\n";
        assert_eq!(Multipart::parts(body, "x", 9).unwrap()[0].body, b"b");
    }

    #[test]
    fn what_is_cut_short_or_not_made_as_it_says_is_nothing() {
        for body in [
            &b""[..],
            b"no marks at all",
            b"--x",
            b"--x\r\n",
            b"--x\r\nContent-Disposition: form-data; name=\"a\"",
            b"--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nno end",
            b"--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nb\r\n--x\r\n",
        ] {
            assert_eq!(
                Multipart::parts(body, "x", 9),
                Err(MultipartError::Unreadable),
                "{}",
                String::from_utf8_lossy(body)
            );
        }
    }

    #[test]
    fn more_parts_than_may_be_read_are_refused_before_they_are_all_read() {
        let one = "--x\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\nb\r\n";
        let body = format!("{}--x--", one.repeat(5));
        assert_eq!(Multipart::parts(body.as_bytes(), "x", 5).unwrap().len(), 5);
        assert_eq!(Multipart::parts(body.as_bytes(), "x", 4), Err(MultipartError::TooMany));
    }

    #[test]
    fn a_part_with_no_name_is_left_out() {
        let body =
            b"--x\r\nContent-Type: text/plain\r\n\r\nb\r\n--x\r\nContent-Disposition: form-data\r\n\r\nc\r\n--x--";
        assert_eq!(Multipart::parts(body, "x", 9).unwrap(), []);
    }

    #[test]
    fn a_name_in_quotes_may_hold_anything() {
        let of = |parameters: &str, name: &str| Multipart::parameter(parameters, name);
        assert_eq!(of("; name=\"a;b\"; filename=\"c\"", "filename").as_deref(), Some("c"));
        assert_eq!(of("; name=\"a\\\"b\"", "name").as_deref(), Some("a\"b"));
        assert_eq!(of("; name=\"a%22b\"", "name").as_deref(), Some("a\"b"));
        assert_eq!(of(" name=plain ; x=1", "name").as_deref(), Some("plain"));
        assert_eq!(of("; name=\"a\"", "other"), None);
        assert_eq!(of("; broken", "name"), None);
    }
}

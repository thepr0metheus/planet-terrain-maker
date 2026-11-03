//! A message's header fields, as they came: in their order, under their own spelling.

use rules::Letters;

/// One header field. The value stays bytes: HTTP says nothing of its encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// The name, spelled as the sender spelled it.
    pub name: String,
    /// The value, without the spaces around it.
    pub value: Vec<u8>,
}

/// What a request's `Content-Length` says, read one way for whoever asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentLength {
    /// Not sent, or sent empty.
    Unsaid,
    /// This many bytes follow, in digits alone. More than a number here can hold is `usize::MAX`, which is past any limit.
    Bytes(usize),
    /// Anything else, as it was sent.
    Other(String),
}

/// The fields of a message. A name given twice stays twice: `get` reads the first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers {
    fields: Vec<Field>,
}

impl Headers {
    /// No fields yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a field after the others.
    pub fn push(&mut self, name: impl Into<String>, value: impl Into<Vec<u8>>) {
        self.fields.push(Field { name: name.into(), value: value.into() });
    }

    /// The first value of `name` as text, or `None` when the message does not carry it. An empty value is `Some("")`:
    /// said empty and not said are two answers.
    pub fn get(&self, name: &str) -> Option<String> {
        self.fields.iter().find(|field| field.name.eq_ignore_ascii_case(name)).map(|field| Self::text(&field.value))
    }

    /// The type of the content without its parameters, in small letters; "" when the message says none.
    pub fn mimetype(&self) -> String {
        // absent-ok: a request that names no type has none, and "" is the type of nothing here.
        let said = self.get("Content-Type").unwrap_or_default();
        // absent-ok: a split gives a first piece.
        Letters::strip(said.split(';').next().unwrap_or_default()).to_lowercase()
    }

    /// Whether the content calls itself JSON: `application/json` or `application/<anything>+json`.
    pub fn says_json(&self) -> bool {
        let kind = self.mimetype();
        kind == "application/json" || (kind.starts_with("application/") && kind.ends_with("+json"))
    }

    /// Every value of `name`, in their order.
    pub fn all(&self, name: &str) -> Vec<String> {
        self.fields
            .iter()
            .filter(|field| field.name.eq_ignore_ascii_case(name))
            .map(|field| Self::text(&field.value))
            .collect()
    }

    /// What `Content-Length` says. Two that differ, or one that is not digits, say `Other`: a body of an unknown length
    /// would be read as the next request.
    pub fn content_length(&self) -> ContentLength {
        let said = self.all("Content-Length");
        if let [first, others @ ..] = said.as_slice()
            && others.iter().any(|other| other != first)
        {
            return ContentLength::Other(said.join(", "));
        }
        let Some(said) = said.into_iter().next().filter(|said| !said.is_empty()) else {
            return ContentLength::Unsaid;
        };
        if Letters::is_digits(&said) {
            ContentLength::Bytes(said.parse().unwrap_or(usize::MAX))
        } else {
            ContentLength::Other(said)
        }
    }

    /// The fields in their order.
    pub fn iter(&self) -> std::slice::Iter<'_, Field> {
        self.fields.iter()
    }

    /// A value's bytes as latin-1 text, the way clients read it.
    fn text(value: &[u8]) -> String {
        value.iter().map(|byte| char::from(*byte)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Headers {
        let mut headers = Headers::new();
        headers.push("X-One", "1");
        headers.push("x-one", "2");
        headers.push("X-Empty", "");
        headers.push("X-Bytes", vec![0xE9]);
        headers
    }

    #[test]
    fn a_name_is_found_without_case_and_the_first_is_read() {
        assert_eq!(fields().get("X-ONE").as_deref(), Some("1"));
        assert_eq!(fields().get("X-Empty").as_deref(), Some(""));
        assert_eq!(fields().get("X-None"), None);
        assert_eq!(fields().get("X-Bytes").as_deref(), Some("é"));
    }

    #[test]
    fn the_type_of_the_content() {
        let of = |value: &str| {
            let mut headers = Headers::new();
            headers.push("Content-Type", value);
            headers
        };
        assert_eq!(of("Application/JSON; charset=utf-8").mimetype(), "application/json");
        assert!(of("Application/JSON; charset=utf-8").says_json());
        assert!(of("application/vnd.ptm+json").says_json());
        assert!(!of("text/plain").says_json());
        assert!(!of("text/x+json").says_json());
        assert!(!Headers::new().says_json());
        assert_eq!(Headers::new().mimetype(), "");
    }

    #[test]
    fn a_length_is_read_one_way() {
        let of = |value: &str| {
            let mut headers = Headers::new();
            headers.push("content-length", value);
            headers.content_length()
        };
        assert_eq!(Headers::new().content_length(), ContentLength::Unsaid);
        assert_eq!(of(""), ContentLength::Unsaid);
        assert_eq!(of("0"), ContentLength::Bytes(0));
        assert_eq!(of("12"), ContentLength::Bytes(12));
        assert_eq!(of("99999999999999999999999"), ContentLength::Bytes(usize::MAX));
        for other in ["+5", "-1", "1_000", "1.5", "abc", "5, 5"] {
            assert_eq!(of(other), ContentLength::Other(other.to_string()), "{other}");
        }
        let mut two = Headers::new();
        two.push("Content-Length", "5");
        two.push("content-length", "6");
        assert_eq!(two.content_length(), ContentLength::Other("5, 6".to_string()));
        two = Headers::new();
        two.push("Content-Length", "5");
        two.push("Content-Length", "5");
        assert_eq!(two.content_length(), ContentLength::Bytes(5), "the same twice is the same");
    }
}

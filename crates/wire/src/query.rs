//! A URL's query.

use rules::Percent;

/// The pairs of a query string, in their order. A `+` is a space, `%XX` the byte it says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    pairs: Vec<(String, String)>,
}

impl Query {
    /// The pairs of this text. A piece with no `=` is a name with an empty value.
    pub fn parse(text: &str) -> Self {
        let pairs = text
            .split('&')
            .filter(|piece| !piece.is_empty())
            .map(|piece| {
                let (name, value) = piece.split_once('=').unwrap_or((piece, ""));
                (Percent::decode_form(name), Percent::decode_form(value))
            })
            .collect();
        Self { pairs }
    }

    /// The first value of `name`, an empty one too; `None` when it was not asked.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.pairs.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_is_read_as_a_form_is() {
        let query = Query::parse("name=a+b%20c%E1%83%90&x=1&x=2&empty=&bare&&=z");
        assert_eq!(query.get("name"), Some("a b cა"));
        assert_eq!(query.get("x"), Some("1"), "the first");
        assert_eq!(query.get("empty"), Some(""));
        assert_eq!(query.get("bare"), Some(""));
        assert_eq!(query.get(""), Some("z"));
        assert_eq!(query.get("none"), None);
        assert_eq!(Query::parse("").get("a"), None);
    }
}

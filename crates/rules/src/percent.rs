//! Values as a URL carries them.

/// Percent-coding, one for every crate: reading a request's path and query, writing what is asked of a service.
pub struct Percent;

impl Percent {
    /// `%XX` as the byte it says, a `%` that says none as itself. Bytes that are no UTF-8 become the replacement mark.
    pub fn decode(value: &str) -> String {
        String::from_utf8_lossy(&Self::bytes(value)).into_owned()
    }

    /// A value of a query or a form: a `+` is a space.
    pub fn decode_form(value: &str) -> String {
        Self::decode(&value.replace('+', " "))
    }

    /// A value as a form writes it: everything but letters, digits and `_.-~` escaped, a space as a `+`.
    pub fn encode_form(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        for byte in value.bytes() {
            match byte {
                b' ' => out.push('+'),
                b'_' | b'.' | b'-' | b'~' => out.push(char::from(byte)),
                other if other.is_ascii_alphanumeric() => out.push(char::from(other)),
                other => out.push_str(&format!("%{other:02X}")),
            }
        }
        out
    }

    /// Names and values as a query string.
    pub fn form(pairs: &[(&str, String)]) -> String {
        let pieces: Vec<String> = pairs
            .iter()
            .map(|(name, value)| format!("{}={}", Self::encode_form(name), Self::encode_form(value)))
            .collect();
        pieces.join("&")
    }

    fn bytes(value: &str) -> Vec<u8> {
        let bytes = value.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut at = 0;
        while let Some(byte) = bytes.get(at).copied() {
            match (byte == b'%').then(|| Self::hex_pair(bytes.get(at + 1..at + 3))).flatten() {
                Some(decoded) => {
                    out.push(decoded);
                    at += 3;
                }
                None => {
                    out.push(byte);
                    at += 1;
                }
            }
        }
        out
    }

    fn hex_pair(pair: Option<&[u8]>) -> Option<u8> {
        let text = std::str::from_utf8(pair?).ok()?;
        // `from_str_radix` takes a sign, and `%+1` is no escape.
        if !text.bytes().all(|digit| digit.is_ascii_hexdigit()) {
            return None;
        }
        u8::from_str_radix(text, 16).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_percent_that_says_nothing_stays() {
        assert_eq!(Percent::decode("100%+%zz%2"), "100%+%zz%2");
        assert_eq!(Percent::decode("a%20b%E1%83%90"), "a bა");
        assert_eq!(Percent::decode("a%FFb"), "a\u{fffd}b");
    }

    #[test]
    fn a_form_writes_as_urlencode_writes() {
        assert_eq!(Percent::encode_form("a b,c~_.-/ა"), "a+b%2Cc~_.-%2F%E1%83%90");
        assert_eq!(Percent::form(&[("q", "a b".to_string()), ("limit", "8".to_string())]), "q=a+b&limit=8");
        assert_eq!(Percent::decode_form("a+b%2B"), "a b+");
    }
}

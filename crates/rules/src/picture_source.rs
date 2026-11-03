//! A picture source a person enters: an HTTPS address of 256-pixel XYZ tiles. Addresses may hold a viewer's query key:
//! they are data alone, never logged and never fetched by the server. `tests/fixtures/picture-sources.json` holds the
//! cases the page's copy of this rule and this one both go by.

use crate::digest::Digest;
use crate::letters::Letters;
use crate::numbers::Decimal;
use crate::refused::Refused;
use serde_json::{Map, Value};
use std::net::Ipv6Addr;

/// The parts of an address that decide whether it can be used, read as a browser and `urlsplit` read them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct UrlParts {
    scheme: String,
    host: String,
    user: String,
    password: String,
    fragment: String,
}

impl UrlParts {
    fn split(url: &str) -> Option<Self> {
        let cleaned: String = url
            .trim_start_matches(|letter: char| letter <= ' ')
            .chars()
            .filter(|letter| !matches!(letter, '\t' | '\r' | '\n'))
            .collect();
        let (scheme, rest) = Self::scheme_of(&cleaned);
        let mut parts = Self { scheme, ..Self::default() };
        let rest = match rest.strip_prefix("//") {
            Some(after) => {
                let end = after.find(['/', '?', '#']).unwrap_or(after.len());
                let (authority, remainder) = after.split_at(end);
                parts.read_authority(authority)?;
                remainder
            }
            None => rest,
        };
        if let Some((_, fragment)) = rest.split_once('#') {
            parts.fragment = fragment.to_string();
        }
        Some(parts)
    }

    /// The scheme in small letters and what comes after it; none when the address does not start with one.
    fn scheme_of(url: &str) -> (String, &str) {
        let is_scheme = |text: &str| {
            text.chars().next().is_some_and(|first| first.is_ascii_alphabetic())
                && text.chars().all(|letter| letter.is_ascii_alphanumeric() || matches!(letter, '+' | '-' | '.'))
        };
        match url.split_once(':') {
            Some((scheme, rest)) if is_scheme(scheme) => (scheme.to_lowercase(), rest),
            _ => (String::new(), url),
        }
    }

    /// `None` for an authority that cannot be read: an unclosed bracket, a port that is no port.
    fn read_authority(&mut self, authority: &str) -> Option<()> {
        if authority.contains('[') != authority.contains(']') {
            return None;
        }
        let host_and_port = match authority.rsplit_once('@') {
            Some((login, host_and_port)) => {
                let (user, password) = login.split_once(':').unwrap_or((login, ""));
                self.user = user.to_string();
                self.password = password.to_string();
                host_and_port
            }
            None => authority,
        };
        let (host, port) = match host_and_port.split_once('[') {
            Some((before, bracketed)) => {
                let (host, after) = bracketed.split_once(']')?;
                if !before.is_empty() || !(after.is_empty() || after.starts_with(':')) {
                    return None;
                }
                host.parse::<Ipv6Addr>().ok()?;
                // absent-ok: after the bracket comes a port or nothing, as checked above.
                (host, after.strip_prefix(':').unwrap_or(""))
            }
            None => host_and_port.split_once(':').unwrap_or((host_and_port, "")),
        };
        if !port.is_empty() {
            let number: u32 = Letters::is_digits(port).then(|| port.parse().unwrap_or(u32::MAX))?;
            if number > 65535 {
                return None;
            }
        }
        self.host = host.to_string();
        Some(())
    }
}

/// The rule of a picture source.
pub struct PictureSource;

impl PictureSource {
    const MOST_URL: usize = 4096;
    const MOST_ZOOM: f64 = 22.0;
    const FIELDS: [(&'static str, usize); 2] = [("name", 120), ("credit", 600)];
    const NEEDS_XYZ: &'static str = "Use an XYZ tile URL with {z}, {x} and {y}.";

    /// A source as it is kept: `{url, maxZoom, name, credit, key}`, or the words that say why it cannot be used.
    pub fn checked(data: Option<&Value>) -> Result<Value, Refused> {
        let Some(fields) = data.and_then(Value::as_object) else {
            return Err(Refused::new("A picture source must be a JSON object."));
        };
        let url = fields.get("url").and_then(Value::as_str).ok_or_else(|| Refused::new(Self::NEEDS_XYZ))?;
        let url = Self::checked_url(url)?;
        let zoom = Self::checked_zoom(fields.get("maxZoom"))?;
        let mut source = Map::new();
        source.insert("url".to_string(), Value::from(url));
        source.insert("maxZoom".to_string(), zoom);
        for (name, most) in Self::FIELDS {
            let value = match fields.get(name) {
                None => "",
                Some(Value::String(text)) => text,
                Some(_) => return Err(Refused::new("Source name and credit must be text.")),
            };
            source.insert(name.to_string(), Value::from(Letters::head(Letters::strip(value), most)));
        }
        source.insert("key".to_string(), Value::from(Digest::sha256_hex(url.as_bytes())));
        Ok(Value::Object(source))
    }

    /// The address as it is kept: without the spaces around it.
    fn checked_url(url: &str) -> Result<&str, Refused> {
        let url = Letters::strip(url);
        let has_all = ["{z}", "{x}", "{y}"].iter().all(|mark| url.contains(mark));
        if Letters::len(url) > Self::MOST_URL || !has_all || Self::without_marks(url, "").contains(['{', '}']) {
            return Err(Refused::new(Self::NEEDS_XYZ));
        }
        let parts = UrlParts::split(&Self::without_marks(url, "0"))
            .ok_or_else(|| Refused::new("The tile URL must be a valid HTTPS address."))?;
        let first_pieces = url.split('/').take(3).collect::<Vec<_>>().join("/");
        if parts.scheme != "https"
            || parts.host.is_empty()
            || !parts.user.is_empty()
            || !parts.password.is_empty()
            || !parts.fragment.is_empty()
            || first_pieces.contains('{')
        {
            return Err(Refused::new("Use HTTPS without a login, password or fragment in the tile URL."));
        }
        Ok(url)
    }

    /// The address with each `{z}`, `{x}` and `{y}` replaced, in one pass.
    fn without_marks(url: &str, with: &str) -> String {
        let mut out = String::with_capacity(url.len());
        let mut rest = url;
        while let Some(letter) = rest.chars().next() {
            if ["{z}", "{x}", "{y}"].iter().any(|mark| rest.starts_with(mark)) {
                out.push_str(with);
                rest = rest.get(3..).unwrap_or("");
            } else {
                out.push(letter);
                rest = rest.get(letter.len_utf8()..).unwrap_or("");
            }
        }
        out
    }

    /// The last zoom: a whole number from 0 to 22, or null for automatic detail.
    fn checked_zoom(zoom: Option<&Value>) -> Result<Value, Refused> {
        match zoom {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(Value::String(text)) if text.is_empty() || text == "auto" => Ok(Value::Null),
            Some(value) => Decimal::of_value(value)
                .filter(|zoom| zoom.is_finite() && zoom.fract() == 0.0 && (0.0..=Self::MOST_ZOOM).contains(zoom))
                .map(|zoom| Value::from(zoom as u64))
                .ok_or_else(|| Refused::new("The last tile zoom must be a whole number from 0 to 22.")),
        }
    }

    /// The address a request to forget one names, in the form it was kept in.
    pub fn address(url: Option<&Value>) -> Result<String, Refused> {
        let url = url.and_then(Value::as_str).ok_or_else(|| Refused::new(Self::NEEDS_XYZ))?;
        Self::checked_url(url).map(str::to_string)
    }

    /// The list a file holds, each entry checked as a new one is; refused whole when one cannot be used.
    pub fn read_list(list: &Value) -> Result<Vec<Value>, Refused> {
        let items = list.as_array().ok_or_else(|| Refused::new("not a list"))?;
        items.iter().map(|entry| Self::checked(Some(entry))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CASES: &str = include_str!("../../../tests/fixtures/picture-sources.json");

    #[test]
    fn the_cases_the_page_goes_by_too() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        assert!(cases.len() > 10);
        for case in cases {
            assert_eq!(
                PictureSource::checked(Some(&case["source"])).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{case}"
            );
        }
    }

    #[test]
    fn what_is_kept_of_a_source() {
        let url = "https://tiles.example.org/{z}/{x}/{y}.png";
        let source = PictureSource::checked(Some(&json!({"url": format!(" {url} "), "name": " Example ", "credit": " Agency ", "maxZoom": "16", "more": "left out"}))).unwrap();
        assert_eq!(
            source,
            json!({"url": url, "maxZoom": 16, "name": "Example", "credit": "Agency", "key": Digest::sha256_hex(url.as_bytes())})
        );
        assert_eq!(source.as_object().unwrap().keys().collect::<Vec<_>>(), ["url", "maxZoom", "name", "credit", "key"]);
    }

    #[test]
    fn the_addresses_that_cannot_be_used() {
        for (url, words) in [
            ("https://a.org/{z}/{x}/{y}{w}", "XYZ"),
            ("https://a.org/{z}/{x}/{y}}", "XYZ"),
            ("https://a.org/{{z}x}/{y}/{x}", "XYZ"),
            ("ftp://a.org/{z}/{x}/{y}", "HTTPS"),
            ("//a.org/{z}/{x}/{y}", "HTTPS"),
            ("https:///{z}/{x}/{y}", "HTTPS"),
            ("https://user@a.org/{z}/{x}/{y}", "HTTPS"),
            ("https://a.org:99999/{z}/{x}/{y}", "valid"),
            ("https://a.org:x/{z}/{x}/{y}", "valid"),
            ("https://[a.org/{z}/{x}/{y}", "valid"),
            ("https://[zz]/{z}/{x}/{y}", "valid"),
        ] {
            let refused = PictureSource::checked(Some(&json!({"url": url}))).unwrap_err().0;
            assert!(refused.contains(words), "{url}: {refused}");
        }
        for url in [
            "HTTPS://a.org/{z}/{x}/{y}",
            "https://a.org:8443/{z}/{x}/{y}",
            "https://[::1]:8443/{z}/{x}/{y}",
            "https://a.org/{z}/{x}/{y}?key=abc",
            "https://@a.org/{z}/{x}/{y}",
        ] {
            assert!(PictureSource::checked(Some(&json!({"url": url}))).is_ok(), "{url}");
        }
    }

    #[test]
    fn zooms_and_texts() {
        let url = "https://a.org/{z}/{x}/{y}";
        let zoom = |zoom: Value| PictureSource::checked(Some(&json!({"url": url, "maxZoom": zoom})));
        for nothing in [json!(null), json!(""), json!("auto")] {
            assert_eq!(zoom(nothing).unwrap()["maxZoom"], Value::Null);
        }
        assert_eq!(zoom(json!(7.0)).unwrap()["maxZoom"], 7);
        assert_eq!(zoom(json!("7.0")).unwrap()["maxZoom"], 7);
        for wrong in [json!("x"), json!([1]), json!(true), json!(23), json!(-1), json!(2.5)] {
            assert!(zoom(wrong).is_err());
        }
        assert!(PictureSource::checked(Some(&json!({"url": url, "name": 5}))).is_err());
        assert!(PictureSource::checked(Some(&json!({"url": url, "credit": null}))).is_err());
        assert!(PictureSource::checked(Some(&json!([1]))).is_err());
        assert!(PictureSource::checked(None).is_err());
        let cut = PictureSource::checked(Some(&json!({"url": url, "name": "ა".repeat(200)}))).unwrap();
        assert_eq!(cut["name"].as_str().unwrap().chars().count(), 120);
    }

    #[test]
    fn a_list_that_holds_what_cannot_be_used_is_refused_whole() {
        let good = json!({"url": "https://a.org/{z}/{x}/{y}"});
        assert_eq!(PictureSource::read_list(&json!([good])).unwrap().len(), 1);
        assert!(PictureSource::read_list(&json!({"not": "a list"})).is_err());
        assert!(PictureSource::read_list(&json!([good, {"url": "http://a/{z}/{x}/{y}"}])).is_err());
        assert!(PictureSource::read_list(&json!([5])).is_err());
    }

    #[test]
    fn the_address_to_forget() {
        assert_eq!(
            PictureSource::address(Some(&json!(" https://a.org/{z}/{x}/{y} "))).unwrap(),
            "https://a.org/{z}/{x}/{y}"
        );
        assert!(PictureSource::address(None).is_err());
        assert!(PictureSource::address(Some(&json!(5))).is_err());
        assert!(PictureSource::address(Some(&json!("invalid"))).is_err());
    }
}

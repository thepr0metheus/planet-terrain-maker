//! A JSON value in one format, to the byte. The files in the data folder and the answers were all written so: a file
//! read and written back does not change, and an old version of the server reads what a new one wrote.

use crate::numbers::PyFloat;
use serde_json::Value;

/// One way of writing JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonForm {
    ascii: bool,
    between: &'static str,
    after_key: &'static str,
    sorted: bool,
    indent: Option<usize>,
}

impl JsonForm {
    /// A line of a report: letters as they stand, a space after `,` and `:`.
    pub const TEXT: Self = Self { ascii: false, between: ", ", after_key: ": ", sorted: false, indent: None };
    /// As `TEXT`, with ASCII escapes.
    pub const ASCII: Self = Self { ascii: true, between: ", ", after_key: ": ", sorted: false, indent: None };
    /// An answer: letters as they stand, keys sorted, no spaces.
    pub const ANSWER: Self = Self { ascii: false, between: ",", after_key: ":", sorted: true, indent: None };
    /// A file of a model or of the picture sources: an item a line, a space to a level, keys in their order.
    pub const FILE: Self = Self::TEXT.indented(1);
    /// The settings' file: as `FILE`, with ASCII escapes.
    pub const ASCII_FILE: Self = Self::ASCII.indented(1);
    /// A kept answer of Overpass: no spaces, with ASCII escapes.
    pub const ASCII_COMPACT: Self = Self { ascii: true, between: ",", after_key: ":", sorted: false, indent: None };

    /// Each item on its own line, `n` spaces to a level: `,` then ends the line with no space.
    const fn indented(self, n: usize) -> Self {
        Self { ascii: self.ascii, between: ",", after_key: self.after_key, sorted: self.sorted, indent: Some(n) }
    }

    /// The value's text.
    pub fn write(&self, value: &Value) -> String {
        let mut out = String::new();
        self.put(&mut out, value, 0);
        out
    }

    fn put(&self, out: &mut String, value: &Value, depth: usize) {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            Value::Number(number) => match number.as_f64().filter(|_| number.is_f64()) {
                Some(float) => out.push_str(&PyFloat::repr(float)),
                None => out.push_str(&number.to_string()),
            },
            Value::String(text) => self.string(out, text),
            Value::Array(items) => {
                out.push('[');
                for (at, item) in items.iter().enumerate() {
                    self.before_item(out, at, depth + 1);
                    self.put(out, item, depth + 1);
                }
                self.closing(out, items.is_empty(), depth, ']');
            }
            Value::Object(fields) => {
                out.push('{');
                let mut pairs: Vec<(&String, &Value)> = fields.iter().collect();
                if self.sorted {
                    pairs.sort_by(|one, other| one.0.cmp(other.0));
                }
                for (at, (key, item)) in pairs.into_iter().enumerate() {
                    self.before_item(out, at, depth + 1);
                    self.string(out, key);
                    out.push_str(self.after_key);
                    self.put(out, item, depth + 1);
                }
                self.closing(out, fields.is_empty(), depth, '}');
            }
        }
    }

    fn before_item(&self, out: &mut String, at: usize, depth: usize) {
        if at > 0 {
            out.push_str(self.between);
        }
        self.line(out, depth);
    }

    fn closing(&self, out: &mut String, empty: bool, depth: usize, mark: char) {
        if !empty {
            self.line(out, depth);
        }
        out.push(mark);
    }

    fn line(&self, out: &mut String, depth: usize) {
        if let Some(indent) = self.indent {
            out.push('\n');
            out.push_str(&" ".repeat(indent * depth));
        }
    }

    /// A string, with ASCII escapes under `ascii`, a letter past the basic plane as its two surrogates.
    fn string(&self, out: &mut String, text: &str) {
        out.push('"');
        for letter in text.chars() {
            match letter {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                ' '..='~' => out.push(letter),
                '\u{0}'..='\u{1f}' => Self::escaped(out, letter),
                other if self.ascii => Self::escaped(out, other),
                other => out.push(other),
            }
        }
        out.push('"');
    }

    fn escaped(out: &mut String, letter: char) {
        let mut units = [0u16; 2];
        for unit in letter.encode_utf16(&mut units) {
            out.push_str(&format!("\\u{unit:04x}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_ways_of_dumps_are_pythons() {
        let value = json!({"b": [1, 1.0, "ა"], "a": {"x": null, "y": true}, "e": [], "o": {}});
        assert_eq!(
            JsonForm::TEXT.write(&value),
            r#"{"b": [1, 1.0, "ა"], "a": {"x": null, "y": true}, "e": [], "o": {}}"#
        );
        assert_eq!(JsonForm::ASCII.write(&json!("ა😀")), r#""\u10d0\ud83d\ude00""#);
        assert_eq!(JsonForm::ASCII_COMPACT.write(&json!({"a": [1, 2]})), r#"{"a":[1,2]}"#);
        assert_eq!(JsonForm::ANSWER.write(&json!({"b": 1, "a": {"d": 2, "c": "ა"}})), r#"{"a":{"c":"ა","d":2},"b":1}"#);
        assert_eq!(
            JsonForm::FILE.write(&json!({"a": [1, {"b": []}], "c": {}})),
            "{\n \"a\": [\n  1,\n  {\n   \"b\": []\n  }\n ],\n \"c\": {}\n}"
        );
        assert_eq!(JsonForm::ASCII_FILE.write(&json!({"a": "ა"})), "{\n \"a\": \"\\u10d0\"\n}");
    }

    #[test]
    fn floats_and_control_letters_as_python_writes_them() {
        assert_eq!(JsonForm::TEXT.write(&json!([1e-7, 1.5e300, 0.1, 5, 1e22])), "[1e-07, 1.5e+300, 0.1, 5, 1e+22]");
        assert_eq!(JsonForm::TEXT.write(&json!("a\"\\\n\t\u{1}\u{7f}ა")), "\"a\\\"\\\\\\n\\t\\u0001\u{7f}ა\"");
        assert_eq!(JsonForm::ASCII.write(&json!("\u{7f}")), "\"\\u007f\"");
    }
}

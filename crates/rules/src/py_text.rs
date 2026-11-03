//! Values as text, in the words Python used: some of the app's words quote what was sent, and what was taken as text
//! yesterday must be taken the same today.

use crate::json_form::JsonForm;
use crate::numbers::PyFloat;
use serde_json::Value;

/// A value as the words of the app say it.
pub struct PyText;

impl PyText {
    /// A text in quotes, as it is quoted in a refusal: `'moon'`, and `"it's"` when it holds a quote.
    pub fn repr(text: &str) -> String {
        let quote = if text.contains('\'') && !text.contains('"') { '"' } else { '\'' };
        let mut out = String::with_capacity(text.len() + 2);
        out.push(quote);
        for letter in text.chars() {
            match letter {
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                other if other == quote => {
                    out.push('\\');
                    out.push(other);
                }
                other if u32::from(other) < 0x20 || (0x7f..=0xa0).contains(&u32::from(other)) || other == '\u{ad}' => {
                    out.push_str(&format!("\\x{:02x}", u32::from(other)));
                }
                other => out.push(other),
            }
        }
        out.push(quote);
        out
    }

    /// A value of a request as text: a text as it is, a number in its digits, `null` as `None`. A list or a table,
    /// which nothing here asks for, as its JSON.
    pub fn of(value: &Value) -> String {
        match value {
            Value::String(text) => text.clone(),
            Value::Null => "None".to_string(),
            Value::Bool(true) => "True".to_string(),
            Value::Bool(false) => "False".to_string(),
            Value::Number(number) => match number.as_f64().filter(|_| number.is_f64()) {
                Some(float) => PyFloat::repr(float),
                None => number.to_string(),
            },
            other => JsonForm::TEXT.write(other),
        }
    }

    /// Whether a value counts as something: not `null`, `false`, zero, nor an empty text, list or table.
    pub fn is_something(value: &Value) -> bool {
        match value {
            Value::Null => false,
            Value::Bool(flag) => *flag,
            Value::Number(number) => number.as_f64().is_none_or(|float| float != 0.0),
            Value::String(text) => !text.is_empty(),
            Value::Array(items) => !items.is_empty(),
            Value::Object(fields) => !fields.is_empty(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_text_is_quoted_as_python_quotes_it() {
        for (text, want) in [
            ("moon", "'moon'"),
            ("it's", "\"it's\""),
            ("a\"b'c", "'a\"b\\'c'"),
            ("../evil.bin", "'../evil.bin'"),
            ("a\nb\\", "'a\\nb\\\\'"),
            ("\u{1}", "'\\x01'"),
            ("ბათუმი", "'ბათუმი'"),
        ] {
            assert_eq!(PyText::repr(text), want, "{text}");
        }
    }

    #[test]
    fn a_value_as_text() {
        for (value, want) in [
            (json!("a"), "a"),
            (json!(null), "None"),
            (json!(true), "True"),
            (json!(5), "5"),
            (json!(1.5), "1.5"),
            (json!(1.0), "1.0"),
            (json!([1, "a"]), "[1, \"a\"]"),
        ] {
            assert_eq!(PyText::of(&value), want, "{value}");
        }
    }

    #[test]
    fn what_counts_as_nothing() {
        for value in [json!(null), json!(false), json!(0), json!(0.0), json!(""), json!([]), json!({})] {
            assert!(!PyText::is_something(&value), "{value}");
        }
        for value in [json!(true), json!(1), json!("a"), json!([0]), json!({"a": 0})] {
            assert!(PyText::is_something(&value), "{value}");
        }
    }
}

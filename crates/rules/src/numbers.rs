//! Numbers read and written in the forms the app has always used, where Rust's own differ: a rounding of a tie, the
//! digits of a float, the spaces around a number.

use crate::letters::Letters;
use serde_json::{Number, Value};

/// A decimal number, as text or as JSON.
pub struct Decimal;

impl Decimal {
    /// The number this text says: spaces around it do not count. `inf` and `nan` are numbers here: the caller asks
    /// `is_finite`, and says "out of range".
    pub fn read(text: &str) -> Option<f64> {
        Letters::strip(text).parse().ok()
    }

    /// The number a JSON value says: a number, or a text that reads as one. `true` is no number.
    pub fn of_value(value: &Value) -> Option<f64> {
        match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => Self::read(text),
            _ => None,
        }
    }

    /// A float as a JSON value; a number without digits, which JSON has no way to say, as null.
    pub fn value(number: f64) -> Value {
        // absent-ok: JSON has no number without digits, and null is what such a number is said as.
        Number::from_f64(number).map_or(Value::Null, Value::Number)
    }
}

/// A whole number as text.
pub struct Whole;

impl Whole {
    /// The number this text says: spaces around it do not count, a sign may stand before it. More than an `i64` holds
    /// is the most it holds, which is past every limit here.
    pub fn read(text: &str) -> Option<i64> {
        let text = Letters::strip(text);
        let (negative, digits) = match text.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, text.strip_prefix('+').unwrap_or(text)),
        };
        if !Letters::is_digits(digits) {
            return None;
        }
        let far = if negative { i64::MIN } else { i64::MAX };
        Some(text.parse().unwrap_or(far))
    }
}

/// A float as Python writes it: every float that went into a file or an answer was written so.
pub struct PyFloat;

impl PyFloat {
    /// The shortest digits that read back, always with a point or an exponent, in exponent form below 1e-4 and from 1e16.
    pub fn repr(value: f64) -> String {
        let scientific = format!("{value:e}");
        let Some((digits, exponent)) = scientific.split_once('e') else {
            return scientific;
        };
        // absent-ok: Rust's exponent form always has a whole exponent; zero leaves the number in its plain form.
        let exponent: i32 = exponent.parse().unwrap_or(0);
        if (-4..16).contains(&exponent) {
            let plain = format!("{value}");
            return if plain.contains('.') { plain } else { format!("{plain}.0") };
        }
        let sign = if exponent < 0 { '-' } else { '+' };
        format!("{digits}e{sign}{:02}", exponent.abs())
    }

    /// This many digits after the point, a tie going to the even digit: `%.5f`.
    pub fn fixed(value: f64, digits: usize) -> String {
        format!("{value:.digits$}")
    }

    /// Rounded to this many digits after the point: `round(value, digits)`.
    pub fn round(value: f64, digits: usize) -> f64 {
        Self::fixed(value, digits).parse().unwrap_or(value)
    }

    /// To the nearest whole number, a tie going to the even one: `round(value)`.
    pub fn round_whole(value: f64) -> i64 {
        value.round_ties_even() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_float_is_written_as_python_repr_writes_it() {
        for (value, want) in [
            (0.0, "0.0"),
            (-0.0, "-0.0"),
            (1.0, "1.0"),
            (0.7, "0.7"),
            (-2.5, "-2.5"),
            (100000.0, "100000.0"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1.5e22, "1.5e+22"),
            (1e100, "1e+100"),
            (1_790_000_000.25, "1790000000.25"),
            (41.5005, "41.5005"),
        ] {
            assert_eq!(PyFloat::repr(value), want, "{value}");
        }
    }

    #[test]
    fn a_tie_goes_to_the_even_digit_as_in_python() {
        // The right column is what Python 3.13 prints.
        for (value, digits, want) in [
            (0.015625, 5, "0.01562"),
            (0.046875, 5, "0.04688"),
            (0.125, 2, "0.12"),
            (0.375, 2, "0.38"),
            (2.5, 0, "2"),
            (3.5, 0, "4"),
            (0.5, 0, "0"),
            (1.5, 0, "2"),
            (2.675, 2, "2.67"),
            (41.6, 5, "41.60000"),
            (-0.000001, 5, "-0.00000"),
        ] {
            assert_eq!(PyFloat::fixed(value, digits), want, "{value}");
        }
        assert_eq!(PyFloat::round(41.123456789, 6), 41.123457);
        assert_eq!(PyFloat::round(7.12345, 2), 7.12);
        assert_eq!(PyFloat::round(0.125, 2), 0.12);
        assert_eq!(PyFloat::round_whole(2.5), 2);
        assert_eq!(PyFloat::round_whole(3.5), 4);
    }

    #[test]
    fn numbers_as_text() {
        for (text, want) in
            [(" 5", Some(5.0)), ("1e3", Some(1000.0)), (".5", Some(0.5)), ("5.", Some(5.0)), ("+5", Some(5.0))]
        {
            assert_eq!(Decimal::read(text), want, "{text}");
        }
        for text in ["", "a", "1,5", "0x10", "1 2", "."] {
            assert_eq!(Decimal::read(text), None, "{text}");
        }
        assert!(Decimal::read("nan").is_some_and(f64::is_nan));
        assert!(Decimal::read("-inf").is_some_and(f64::is_infinite));
        assert!(Decimal::read("infinity").is_some_and(f64::is_infinite));
    }

    #[test]
    fn whole_numbers_as_text() {
        for (text, want) in [
            ("5", Some(5)),
            (" -5 ", Some(-5)),
            ("+7", Some(7)),
            ("007", Some(7)),
            ("", None),
            ("5.0", None),
            ("a", None),
            ("-", None),
        ] {
            assert_eq!(Whole::read(text), want, "{text}");
        }
        assert_eq!(Whole::read("99999999999999999999"), Some(i64::MAX));
        assert_eq!(Whole::read("-99999999999999999999"), Some(i64::MIN));
    }

    #[test]
    fn numbers_as_json() {
        assert_eq!(Decimal::of_value(&Value::from(5)), Some(5.0));
        assert_eq!(Decimal::of_value(&Value::from("5.5")), Some(5.5));
        assert_eq!(Decimal::of_value(&Value::Bool(true)), None);
        assert_eq!(Decimal::of_value(&Value::Null), None);
        assert_eq!(Decimal::value(f64::NAN), Value::Null);
    }
}

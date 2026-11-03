//! Text measured and cut one way, where Rust's `str` goes another: a length in letters, a wider set of spaces. What
//! lies in the data folder was measured so, and a limit moved by a letter would refuse what was taken yesterday.

/// Text in this format. Every limit of the app is in letters, not bytes.
pub struct Letters;

impl Letters {
    /// A space: Rust's whitespace and the four separators U+001C to U+001F, as the files were written.
    pub fn is_space(letter: char) -> bool {
        letter.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&letter)
    }

    /// Without the spaces at its ends.
    pub fn strip(text: &str) -> &str {
        text.trim_matches(Self::is_space)
    }

    /// The pieces between runs of spaces.
    pub fn words(text: &str) -> Vec<&str> {
        text.split(Self::is_space).filter(|piece| !piece.is_empty()).collect()
    }

    /// The words joined by one space: no space at the ends, and none twice.
    pub fn collapsed(text: &str) -> String {
        Self::words(text).join(" ")
    }

    /// The first `most` letters.
    pub fn head(text: &str, most: usize) -> &str {
        match text.char_indices().nth(most) {
            Some((at, _)) => text.get(..at).unwrap_or(text),
            None => text,
        }
    }

    /// Its length in letters.
    pub fn len(text: &str) -> usize {
        text.chars().count()
    }

    /// What is read as a number here: ASCII digits, at least one.
    pub fn is_digits(text: &str) -> bool {
        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spaces_are_the_wide_set() {
        assert_eq!(Letters::strip(" \t\u{1c}\u{a0}text\u{2003}\n"), "text");
        assert_eq!(Letters::words("  a\t b\u{a0}c\n"), ["a", "b", "c"]);
        assert_eq!(Letters::collapsed("  Batumi  and\u{1f}Elbrus "), "Batumi and Elbrus");
        assert!(Letters::words(" ").is_empty());
    }

    #[test]
    fn a_length_is_in_letters() {
        assert_eq!(Letters::len("აბგ"), 3);
        assert_eq!(Letters::head("აბგ", 2), "აბ");
        assert_eq!(Letters::head("აბგ", 9), "აბგ");
    }

    #[test]
    fn digits() {
        assert!(Letters::is_digits("0123"));
        assert!(
            !Letters::is_digits("")
                && !Letters::is_digits("1a")
                && !Letters::is_digits("-1")
                && !Letters::is_digits("٣")
        );
    }
}

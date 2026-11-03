//! A moment as text.

/// The forms a moment is written in. Always UTC: the server's stamps do not depend on where it runs.
pub struct Stamp;

impl Stamp {
    const DAYS: [&'static str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&'static str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    /// `2026-11-02T12:34:56+00:00`: when a model was made or changed.
    pub fn iso(now: f64) -> String {
        let (year, month, day, time) = Self::parts(now);
        format!("{year:04}-{month:02}-{day:02}T{time}+00:00")
    }

    /// `2026-11-02 12:34:56`: the log, and the page's reports.
    pub fn plain(now: f64) -> String {
        let (year, month, day, time) = Self::parts(now);
        format!("{year:04}-{month:02}-{day:02} {time}")
    }

    /// `Mon, 02 Nov 2026 12:34:56 GMT`: the field `Date`.
    pub fn http(now: f64) -> String {
        let (year, month, day, time) = Self::parts(now);
        let days = (now.max(0.0) as u64) / 86_400;
        // absent-ok: both indexes are in range by the arithmetic, and a clippy-safe read has no panic to name.
        let weekday = Self::DAYS.get((days % 7) as usize).copied().unwrap_or_default();
        // absent-ok: as above.
        let month = Self::MONTHS.get((month - 1) as usize).copied().unwrap_or_default();
        format!("{weekday}, {day:02} {month} {year} {time} GMT")
    }

    fn parts(now: f64) -> (u64, u64, u64, String) {
        let seconds = now.max(0.0) as u64;
        let (year, month, day) = Self::civil_from_days(seconds / 86_400);
        let of_day = seconds % 86_400;
        (year, month, day, format!("{:02}:{:02}:{:02}", of_day / 3600, of_day / 60 % 60, of_day % 60))
    }

    /// Days since 1970-01-01 as (year, month, day): Howard Hinnant's `civil_from_days`, for days after the epoch.
    fn civil_from_days(days: u64) -> (u64, u64, u64) {
        let shifted = days + 719_468;
        let era = shifted / 146_097;
        let day_of_era = shifted % 146_097;
        let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let shifted_month = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
        let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
        (year_of_era + era * 400 + u64::from(month <= 2), month, day)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moment_in_each_form() {
        assert_eq!(Stamp::iso(1_793_491_199.9), "2026-10-31T23:59:59+00:00");
        assert_eq!(Stamp::plain(0.0), "1970-01-01 00:00:00");
        assert_eq!(Stamp::http(784_111_777.0), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(Stamp::http(951_825_600.0), "Tue, 29 Feb 2000 12:00:00 GMT");
        assert_eq!(Stamp::http(4_107_542_400.0), "Mon, 01 Mar 2100 00:00:00 GMT");
    }
}

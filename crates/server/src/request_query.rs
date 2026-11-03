//! Reading what the address of a request says: the pieces of its path, and its query. What it may say is a rule of
//! `rules`; this is where the request hands it over.

use crate::exchange::Exchange;
use crate::failure::Failure;
use rules::Region;
use rules::region::{AskedNumber, Cells, PictureSize};

impl Exchange<'_> {
    /// A varying piece of the path; "" for one the route has not.
    pub fn param(&self, name: &str) -> &str {
        // absent-ok: a route reads only the pieces of its own rule; one it has not is nothing.
        self.params.iter().find(|(known, _)| *known == name).map_or("", |(_, value)| value.as_str())
    }

    /// A piece of the path that is digits, as a number; `None` when it is more than a number here holds, which is past
    /// every limit.
    pub fn whole(&self, name: &str) -> Option<u64> {
        self.param(name).parse().ok()
    }

    /// The first value of a name of the query.
    pub fn asked(&self, name: &str) -> Option<&str> {
        self.query.get(name)
    }

    /// A number of the query within its limits.
    pub fn number(&self, name: &str, low: Option<f64>, high: Option<f64>) -> Result<f64, Failure> {
        AskedNumber::read(name, self.asked(name), low, high).map_err(|refused| Failure::refused(400, refused.0))
    }

    /// The region the query names.
    pub fn region(&self) -> Result<Region, Failure> {
        Region::asked(self.asked("south"), self.asked("north"), self.asked("west"), self.asked("east"))
            .map_err(|refused| Failure::refused(400, refused.0))
    }

    /// Cells a side at most.
    pub fn cells(&self) -> Result<usize, Failure> {
        Cells::asked(self.asked("cells")).map_err(|refused| Failure::refused(400, refused.0))
    }

    /// The size of a picture the query asks.
    pub fn picture_size(&self) -> Result<(usize, usize), Failure> {
        PictureSize::asked(self.asked("width"), self.asked("height"))
            .map_err(|refused| Failure::refused(400, refused.0))
    }
}

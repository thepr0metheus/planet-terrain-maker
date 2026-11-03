//! An address, and how a path finds it.

use crate::answer::Handled;
use crate::exchange::Exchange;
use crate::route_table::ROUTES;
use rules::Letters;

/// What answers a request.
pub type Handler = fn(&mut Exchange<'_>) -> Handled;

/// One value a route reads from the query string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Param {
    /// Its name.
    pub name: &'static str,
    /// `number`, `integer` or `string`.
    pub kind: &'static str,
    /// What it says.
    pub text: &'static str,
    /// Whether a request must give it.
    pub required: bool,
}

/// One row of the table of addresses: what it does and how it is described.
#[derive(Clone, Copy)]
pub struct Route {
    /// The method.
    pub method: &'static str,
    /// The address, with `<name>`, `<int:name>` and `<path:name>` for what varies.
    pub rule: &'static str,
    /// Its name in the description.
    pub endpoint: &'static str,
    /// What it does, in one line.
    pub summary: &'static str,
    /// What more there is to say; "" for nothing.
    pub more: &'static str,
    /// What it reads from the query.
    pub query: &'static [Param],
    /// What its body is, for those that take one.
    pub body: Option<&'static str>,
    /// What it answers: status and words.
    pub responses: &'static [(u16, &'static str)],
    /// Who answers.
    pub handler: Handler,
}

/// A varying piece of an address, by its name, with what the path said.
pub type Params = Vec<(&'static str, String)>;

/// What a request finds.
pub enum Found {
    /// The row, and the pieces its path said.
    Route(&'static Route, Params),
    /// The path is known, by other methods: these, sorted.
    OtherMethods(Vec<&'static str>),
    /// No address is like this path.
    Nothing,
}

/// How a path finds its row.
pub struct RouteFinder;

impl RouteFinder {
    /// What this method on this path finds. The path is decoded: an escaped slash in it is a slash.
    pub fn find(method: &str, path: &str) -> Found {
        Self::in_table(&ROUTES, method, path)
    }

    /// As `find`, in a table: the row that takes both, or else the methods of the rows that take the path. A row that
    /// takes whatever is left of a path comes after all the others, wherever it stands.
    fn in_table(table: &'static [Route], method: &str, path: &str) -> Found {
        let takes_the_rest = |route: &&Route| route.rule.contains("<path:");
        let exact = table.iter().filter(|route| !takes_the_rest(route));
        let mut others = Vec::new();
        for route in exact.chain(table.iter().filter(takes_the_rest)) {
            if let Some(params) = Self::read(route.rule, path) {
                if route.method == method {
                    return Found::Route(route, params);
                }
                others.push(route.method);
            }
        }
        if others.is_empty() { Found::Nothing } else { Found::OtherMethods(others) }
    }

    /// The pieces this path says, if the rule takes it.
    fn read(rule: &'static str, path: &str) -> Option<Params> {
        let mut pieces = path.strip_prefix('/')?;
        let mut params = Vec::new();
        let mut rule_pieces = rule.strip_prefix('/')?.split('/').peekable();
        while let Some(piece) = rule_pieces.next() {
            let (head, rest) = pieces.split_once('/').map_or((pieces, None), |(head, rest)| (head, Some(rest)));
            match Self::variable(piece) {
                Some(("path", name)) => {
                    if pieces.is_empty() || pieces.starts_with('/') {
                        return None;
                    }
                    params.push((name, pieces.to_string()));
                    return Some(params);
                }
                Some(("int", name)) if Letters::is_digits(head) => params.push((name, head.to_string())),
                Some((_, name))
                    if !head.is_empty() && Self::variable(piece).is_some_and(|(kind, _)| kind == "text") =>
                {
                    params.push((name, head.to_string()));
                }
                None if piece == head => {}
                _ => return None,
            }
            match (rest, rule_pieces.peek().is_some()) {
                (Some(rest), true) => pieces = rest,
                (None, false) => return Some(params),
                _ => return None,
            }
        }
        None
    }

    /// (converter, name) of a piece of a rule that varies.
    fn variable(piece: &'static str) -> Option<(&'static str, &'static str)> {
        let inside = piece.strip_prefix('<')?.strip_suffix('>')?;
        Some(inside.split_once(':').unwrap_or(("text", inside)))
    }

    /// The methods a request may use on a path: those of its rows, HEAD with GET, and OPTIONS. As `Allow` says them.
    pub fn allowed(methods: &[&'static str]) -> String {
        let mut all = methods.to_vec();
        all.push("OPTIONS");
        if all.contains(&"GET") {
            all.push("HEAD");
        }
        all.sort_unstable();
        all.dedup();
        all.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(rule: &'static str, path: &str) -> Option<Vec<(&'static str, String)>> {
        RouteFinder::read(rule, path)
    }

    fn pairs(list: &[(&'static str, &str)]) -> Vec<(&'static str, String)> {
        list.iter().map(|(name, value)| (*name, value.to_string())).collect()
    }

    #[test]
    fn a_path_is_read_by_its_rule() {
        assert_eq!(params("/", "/"), Some(vec![]));
        assert_eq!(params("/healthz", "/healthz"), Some(vec![]));
        assert_eq!(params("/healthz", "/healthz/"), None);
        assert_eq!(params("/healthz", "/other"), None);
        assert_eq!(
            params("/api/tile/<source>/<int:z>/<int:x>/<int:y>", "/api/tile/earth-photo/3/1/2"),
            Some(pairs(&[("source", "earth-photo"), ("z", "3"), ("x", "1"), ("y", "2")]))
        );
        assert_eq!(params("/api/tile/<source>/<int:z>/<int:x>/<int:y>", "/api/tile/earth-photo/a/1/2"), None);
        assert_eq!(params("/api/tile/<source>/<int:z>/<int:x>/<int:y>", "/api/tile/earth-photo/-1/1/2"), None);
        assert_eq!(params("/api/tile/<source>/<int:z>/<int:x>/<int:y>", "/api/tile/earth-photo/1/2"), None);
        assert_eq!(params("/api/models/<model_id>", "/api/models/abc"), Some(pairs(&[("model_id", "abc")])));
        assert_eq!(params("/api/models/<model_id>", "/api/models/"), None);
        assert_eq!(params("/api/models/<model_id>", "/api/models/abc/"), None);
        assert_eq!(params("/api/models/<model_id>", "/api/models/a/b"), None);
    }

    #[test]
    fn the_address_of_any_file_takes_the_rest() {
        assert_eq!(params("/<path:path>", "/js/app.js"), Some(pairs(&[("path", "js/app.js")])));
        assert_eq!(params("/<path:path>", "/a/"), Some(pairs(&[("path", "a/")])));
        assert_eq!(params("/<path:path>", "/"), None);
        assert_eq!(params("/<path:path>", "//a"), None);
    }

    #[test]
    fn every_method_of_a_path_is_found() {
        assert!(matches!(RouteFinder::find("GET", "/healthz"), Found::Route(route, _) if route.endpoint == "healthz"));
        assert!(
            matches!(RouteFinder::find("GET", "/js/app.js"), Found::Route(route, _) if route.endpoint == "page_file")
        );
        assert!(
            matches!(RouteFinder::find("POST", "/api/models"), Found::Route(route, _) if route.endpoint == "create_model")
        );
        assert!(
            matches!(RouteFinder::find("GET", "/api/models"), Found::Route(route, _) if route.endpoint == "models")
        );
        let Found::OtherMethods(methods) = RouteFinder::find("PATCH", "/api/models") else {
            panic!("no other methods");
        };
        assert_eq!(RouteFinder::allowed(&methods), "GET, HEAD, OPTIONS, POST");
        let Found::OtherMethods(methods) = RouteFinder::find("DELETE", "/nothing") else {
            panic!("no other methods");
        };
        assert_eq!(RouteFinder::allowed(&methods), "GET, HEAD, OPTIONS");
        assert!(matches!(RouteFinder::find("GET", "//nothing"), Found::Nothing));
    }

    #[test]
    fn the_words_of_a_limit_say_the_limit_the_code_holds() {
        use rules::region::{Cells, PictureSize};
        let text_of = |name: &str| {
            ROUTES
                .iter()
                .flat_map(|route| route.query)
                .find(|param| param.name == name)
                .map(|param| param.text)
                .unwrap()
        };
        assert!(text_of("cells").contains(&Cells::MOST.to_string()));
        for side in ["width", "height"] {
            assert!(text_of(side).contains(&format!("{}", PictureSize::MOST as u64)), "{side}");
        }
    }

    #[test]
    fn every_row_of_the_table_says_what_it_does() {
        assert_eq!(ROUTES.len(), 38);
        for route in ROUTES {
            assert!(!route.summary.is_empty(), "{}", route.rule);
            assert!(!route.responses.is_empty(), "{}", route.rule);
            assert!(!route.endpoint.is_empty(), "{}", route.rule);
        }
    }
}

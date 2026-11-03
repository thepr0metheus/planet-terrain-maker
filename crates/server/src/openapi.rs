//! The description of the API at `/openapi.json` (OpenAPI 3.1), made from the table of routes, and the page for people,
//! `docs/http-api.md`, made from the same: `planet-terrain-maker api-doc > docs/http-api.md`, after a change of the API.

use crate::route::Route;
use serde_json::{Map, Value, json};

/// The description.
pub struct ApiDescription;

impl ApiDescription {
    const TITLE: &'static str = "Planet Terrain Maker";
    const NOT_DESCRIBED: &'static str = "Not described.";
    const OPEN: &'static str = "No sign-in: every route is open to whoever reaches the server, as the page itself is. Run it in a private network, or behind a proxy of your own that signs people in.";

    /// The document of these routes, for this version.
    pub fn build(routes: &[Route], version: Option<&str>) -> Value {
        let mut rows: Vec<&Route> = routes.iter().collect();
        rows.sort_by_key(|route| route.rule);
        let mut paths = Map::new();
        for route in rows {
            let (path, path_params) = Self::path_of(route.rule);
            let operations = paths.entry(path).or_insert_with(|| json!({}));
            if let Some(operations) = operations.as_object_mut() {
                operations.insert(route.method.to_lowercase(), Self::operation(route, path_params));
            }
        }
        json!({
            "openapi": "3.1.0",
            "info": {
                "title": Self::TITLE,
                "version": version.unwrap_or("working copy"),
                "description": Self::OPEN,
            },
            "components": {"securitySchemes": {}},
            "paths": paths,
        })
    }

    /// A rule as an OpenAPI path, and its path parameters as (name, type).
    fn path_of(rule: &str) -> (String, Vec<(&str, &str)>) {
        let mut params = Vec::new();
        let pieces: Vec<String> = rule
            .split('/')
            .map(|piece| match piece.strip_prefix('<').and_then(|inside| inside.strip_suffix('>')) {
                Some(inside) => {
                    let (converter, name) = inside.split_once(':').unwrap_or(("string", inside));
                    params.push((name, if converter == "int" { "integer" } else { "string" }));
                    format!("{{{name}}}")
                }
                None => piece.to_string(),
            })
            .collect();
        (pieces.join("/"), params)
    }

    fn operation(route: &Route, path_params: Vec<(&str, &str)>) -> Value {
        let path_parts = path_params
            .into_iter()
            .map(|(name, kind)| json!({"name": name, "in": "path", "required": true, "schema": {"type": kind}}));
        let query_parts = route.query.iter().map(|param| {
            json!({"name": param.name, "in": "query", "required": param.required, "description": param.text, "schema": {"type": param.kind}})
        });
        let parameters: Vec<Value> = path_parts.chain(query_parts).collect();
        let mut responses: Vec<(u16, &str)> = route.responses.to_vec();
        responses.sort_by_key(|(code, _)| *code);
        let mut answers = Map::new();
        for (code, words) in responses {
            answers.insert(code.to_string(), json!({"description": words}));
        }
        if answers.is_empty() {
            answers.insert("200".to_string(), json!({"description": Self::NOT_DESCRIBED}));
        }
        let mut operation = Map::new();
        operation
            .insert("operationId".to_string(), json!(format!("{}_{}", route.endpoint, route.method.to_lowercase())));
        operation.insert("summary".to_string(), json!(route.summary));
        operation.insert("security".to_string(), json!([]));
        operation.insert("parameters".to_string(), Value::Array(parameters));
        operation.insert("responses".to_string(), Value::Object(answers));
        if !route.more.is_empty() {
            operation.insert("description".to_string(), json!(route.more));
        }
        if let Some(body) = route.body {
            operation.insert("requestBody".to_string(), json!({"description": body, "content": {"*/*": {}}}));
        }
        Value::Object(operation)
    }

    /// The text at this place of a document; "" when there is none: the page for people then says nothing of it.
    fn text_at<'a>(value: &'a Value, place: &str) -> &'a str {
        // absent-ok: as above.
        value.pointer(place).and_then(Value::as_str).unwrap_or_default()
    }

    /// The page for people: every route with its summary, what it reads, and what it answers.
    pub fn markdown(spec: &Value) -> String {
        let mut lines = vec![
            format!("# {}: HTTP API", Self::text_at(spec, "/info/title")),
            String::new(),
            "Made from `/openapi.json` by `planet-terrain-maker api-doc`; do not edit by hand.".to_string(),
            String::new(),
            Self::text_at(spec, "/info/description").to_string(),
            String::new(),
        ];
        for (path, operations) in spec.get("paths").and_then(Value::as_object).into_iter().flatten() {
            for (method, operation) in operations.as_object().into_iter().flatten() {
                Self::markdown_of(path, method, operation, &mut lines);
            }
        }
        lines.join("\n")
    }

    fn markdown_of(path: &str, method: &str, operation: &Value, lines: &mut Vec<String>) {
        lines.push(format!("## {} `{path}`", method.to_uppercase()));
        lines.push(String::new());
        lines.push(Self::text_at(operation, "/summary").to_string());
        lines.push(String::new());
        if let Some(more) = operation.get("description").and_then(Value::as_str) {
            lines.push(more.to_string());
            lines.push(String::new());
        }
        for param in operation.get("parameters").and_then(Value::as_array).into_iter().flatten() {
            let need = if param.get("required") == Some(&Value::Bool(true)) { "required" } else { "optional" };
            let words = param.get("description").and_then(Value::as_str);
            // absent-ok: a parameter with no words has none written.
            let said = words.map_or(String::new(), |words| format!(": {words}"));
            lines.push(format!(
                "- `{}` ({}, {}, {need}){said}",
                Self::text_at(param, "/name"),
                Self::text_at(param, "/in"),
                Self::text_at(param, "/schema/type")
            ));
        }
        if let Some(body) = operation.get("requestBody") {
            lines.push(format!("- body: {}", Self::text_at(body, "/description")));
        }
        for (code, answer) in operation.get("responses").and_then(Value::as_object).into_iter().flatten() {
            lines.push(format!("- {code}: {}", Self::text_at(answer, "/description")));
        }
        lines.push(String::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route_table::ROUTES;

    #[test]
    fn the_page_for_people_is_made_from_the_description() {
        let made = ApiDescription::markdown(&ApiDescription::build(&ROUTES, None));
        assert_eq!(
            made,
            include_str!("../../../docs/http-api.md"),
            "run: planet-terrain-maker api-doc > docs/http-api.md"
        );
    }

    #[test]
    fn a_rule_as_a_path() {
        assert_eq!(
            ApiDescription::path_of("/api/tile/<source>/<int:z>/<path:rest>"),
            (
                "/api/tile/{source}/{z}/{rest}".to_string(),
                vec![("source", "string"), ("z", "integer"), ("rest", "string")]
            )
        );
    }

    #[test]
    fn the_version_it_describes() {
        assert_eq!(ApiDescription::build(&ROUTES, Some("abc1234"))["info"]["version"], "abc1234");
        assert_eq!(ApiDescription::build(&ROUTES, None)["info"]["version"], "working copy");
    }
}

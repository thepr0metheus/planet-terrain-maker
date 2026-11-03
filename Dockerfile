# The server is one binary, built here from the code the image is made of, with the packages Cargo.lock names.
FROM rust:1.99.1-alpine AS build
# The toolchain of the image, not a download of the one rust-toolchain.toml names with its components
ENV RUSTUP_TOOLCHAIN=1.99.1
# ring, under rustls, compiles a little C and assembly
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN cargo build --release --locked -p planet-terrain-maker

FROM alpine:3
# The base image is rebuilt now and then, Alpine's fixes come any day: take those that came since
RUN apk upgrade --no-cache
WORKDIR /app
# VERSION names the commit when the code comes as a `git archive` copy; a plain clone leaves its
# placeholder, and /healthz then says "working copy". REQUIRE_COMMIT=1 stops such a build instead.
ARG REQUIRE_COMMIT=0
COPY VERSION ./VERSION
RUN if [ "$REQUIRE_COMMIT" = 1 ] && grep -q 'Format' VERSION; then echo "VERSION has no commit: copy the code with git archive" >&2; exit 1; fi
COPY --from=build /src/target/release/planet-terrain-maker ./planet-terrain-maker
COPY web ./web
# data/ belongs to the user the server runs as, so that a volume made for it can be written
RUN mkdir -p /app/data && chown 1000:1000 /app/data
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=3s CMD ["/app/planet-terrain-maker", "healthcheck"]
CMD ["/app/planet-terrain-maker"]

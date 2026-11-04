#!/usr/bin/env bash
# Prepare the recovered libraries for inclusion (drop serde derive/attributes, inner doc
# comments and cross-crate uses), build, and print the fixture JSON.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$here/target/gen"
sed -E '/^\/\/!/d; /#\[derive\(.*serde/d; /#\[serde/d; s/^#\[cfg\(test\)\]/#[cfg(any())]/' "$here/../legacy/mizan/kww_lib.rs" > "$here/target/gen/kww_lib.rs"
sed -E '/^\/\/!/d; s/^use mizan_kww_engine::constants::\*;/use crate::mizan_kww_engine::constants::*;/; s/^#\[cfg\(test\)\]/#[cfg(any())]/' "$here/../legacy/mizan/confluence_lib.rs" > "$here/target/gen/confluence_lib.rs"
cargo run --quiet --offline --manifest-path "$here/Cargo.toml"

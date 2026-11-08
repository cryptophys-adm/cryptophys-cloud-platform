// The Workers Builds stub for the type-check (see ../wrangler.toml). It is never routed.
export default {
  fetch(): Response {
    return new Response("cryptophys-forge-typecheck: the type-check runs in Workers Builds; this Worker serves nothing.", { status: 404 });
  },
};

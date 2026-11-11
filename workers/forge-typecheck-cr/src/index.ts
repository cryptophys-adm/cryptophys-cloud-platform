// The Workers Builds stub for the change-request type-check (see ../wrangler.toml). It serves nothing.
export default {
  fetch(): Response {
    return new Response("cryptophys-forge-typecheck-cr: change requests are type-checked in Workers Builds; this Worker serves nothing.", { status: 404 });
  },
};

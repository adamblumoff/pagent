# Pagent provisioner

This Cloudflare Worker owns tunnel lifecycle. It never receives Pagent event bodies.

## Bindings

Create a KV namespace for `PAGENT_ENVIRONMENTS`, replace the placeholder IDs in `wrangler.jsonc`, and set these Worker secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_API_TOKEN`, scoped to Cloudflare Tunnel write and zone DNS write
- `PAGENT_PUBLIC_ZONE`, such as `dev.example.com`
- `PAGENT_PROVISIONER_ADMIN_TOKEN`, at least 32 random characters
- `PAGENT_CREDENTIAL_SECRET`, at least 32 random characters

Bind the `PAGENT_ENROLLMENT_LOCKS` Durable Object as shown in `wrangler.jsonc`. It serializes enrollment requests for each token while KV stores token state.

The public zone must already belong to `CLOUDFLARE_ZONE_ID`.

After replacing the KV IDs, deploy with `pnpm --dir provisioner exec wrangler deploy`. The Worker and KV are the only hosted control-plane pieces; event bodies travel from Cloudflare directly through the named tunnel to the running developer machine.

## HTTP contract

- `POST /v1/admin/enrollment-tokens` uses the provisioner administrator bearer credential. Its JSON body is `{ "version": 1, "expiresInSeconds": 300 }`, where the lifetime is from 60 to 86400 seconds. It returns a single-use token and `expiresAt` timestamp.
- `POST /v1/environments` uses a minted enrollment bearer credential and requires `Idempotency-Key`. Its JSON body is `{ "version": 1, "environmentId": "...", "originPort": 43121 }`.
- `POST /v1/environments/:id/rotate` uses the environment management bearer credential and requires `Idempotency-Key`. Its JSON body is `{ "version": 1, "originPort": 43121 }`.
- `DELETE /v1/environments/:id` uses the environment management bearer credential and requires `Idempotency-Key`.

Enrollment creates or resumes one remotely managed tunnel, writes its remote ingress configuration, and upserts a proxied CNAME to `<tunnel-id>.cfargotunnel.com`. The ingress accepts `/v1/events` and `/v1/probe`; its final rule returns 404 for every other path.

Enrollment tokens are stored only as hashes with their expiry and consumed state. The Worker consumes a token after provisioning succeeds. The same environment and idempotency key can replay the completed request, but no other request can reuse the token. Management credentials are derived inside the Worker and stored only as SHA-256 hashes. Tunnel tokens are fetched from Cloudflare when needed and also stored only as hashes. Cloudflare account credentials stay in Worker secrets.

Idempotency records expire after seven days. Tunnel creation also uses a deterministic name, and token rotation derives its tunnel secret from the idempotency key. Those two measures keep retries safe while Workers KV changes propagate.

The Cloudflare calls follow the current API contracts for [tunnel creation](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/), [remote tunnel configuration](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/), [tunnel tokens](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/), and [DNS records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/).

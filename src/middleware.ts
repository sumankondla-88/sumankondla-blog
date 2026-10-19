import { defineMiddleware } from "astro:middleware";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Defense in depth for the Keystatic admin. Cloudflare Access sits in front of the site, but the
// *.workers.dev hostname can bypass an Access app bound to the custom domain, so the Worker also
// verifies the Access JWT itself and fails closed when it is not configured.
const ADMIN = /^\/(?:keystatic(?:\/|$)|api\/keystatic(?:\/|$)|admin\/ai(?:\/|$)|api\/admin(?:\/|$))/;

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksFor = "";

export const onRequest = defineMiddleware(async (context, next) => {
	if (import.meta.env.DEV || !ADMIN.test(context.url.pathname)) return next();

	const env = (context.locals as any).runtime?.env ?? {};
	const team: string | undefined = env.CF_ACCESS_TEAM_DOMAIN; // e.g. "yourteam.cloudflareaccess.com"
	const aud: string | undefined = env.CF_ACCESS_AUD; // Application Audience (AUD) tag
	const deny = (msg: string) => new Response(msg, { status: 403 });

	if (!team || !aud) return deny("Admin is disabled: Cloudflare Access is not configured.");

	const token = context.request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return deny("Forbidden");

	try {
		if (!jwks || jwksFor !== team) {
			jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
			jwksFor = team;
		}
		await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
	} catch {
		return deny("Forbidden");
	}
	return next();
});

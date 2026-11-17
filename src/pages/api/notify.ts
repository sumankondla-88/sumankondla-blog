import type { APIRoute } from "astro";

// On-demand route: emails the Brevo list about newly published posts (see NEWSLETTER.md).
// Called by .github/workflows/notify-subscribers.yml after the daily publish:
//   POST /api/notify            Authorization: Bearer <NOTIFY_TOKEN>
//   POST /api/notify?dry=1      same, but only reports what it would send
//
// No database: it reads the site's own rss.xml and announces every post in it that is not in
// src/data/notify-baseline.json (posts live before emails started) and has no Brevo campaign named
// "New post: <slug>" yet. So each post is announced once, whatever its date, and a missed day is
// caught up on the next run.
export const prerender = false;

import baseline from "../../data/notify-baseline.json";
const ALREADY_LIVE = new Set<string>(baseline.slugs);

const json = (body: Record<string, unknown>, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

type Env = {
	ASSETS?: { fetch: typeof fetch };
	NOTIFY_TOKEN?: string;
	BREVO_API_KEY?: string;
	BREVO_LIST_ID?: string;
	BREVO_SENDER_EMAIL?: string;
	BREVO_SENDER_NAME?: string;
};

type Item = { title: string; link: string; description: string; pubDate: Date; slug: string };

const decode = (s: string) =>
	s
		.replace(/^<!\[CDATA\[|\]\]>$/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.trim();

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseRss(xml: string): Item[] {
	const items: Item[] = [];
	for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const tag = (name: string) => decode(body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
		const link = tag("link");
		const slug = link.match(/\/blog\/([^/]+)\/?$/)?.[1];
		const pubDate = new Date(tag("pubDate"));
		if (!slug || Number.isNaN(pubDate.valueOf())) continue;
		items.push({ title: tag("title"), link, description: tag("description"), pubDate, slug });
	}
	return items;
}

/** Constant-time string compare, so the token can't be guessed byte by byte from timing. */
function same(a: string, b: string) {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

function emailHtml(post: Item, siteName: string) {
	const url = escape(post.link);
	return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<tr><td style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#777;">New post on ${escape(siteName)}</td></tr>
<tr><td style="padding-top:12px;font-size:26px;line-height:1.25;font-weight:600;"><a href="${url}" style="color:#1a1a1a;text-decoration:none;">${escape(post.title)}</a></td></tr>
<tr><td style="padding-top:12px;font-size:16px;line-height:1.6;color:#444;">${escape(post.description)}</td></tr>
<tr><td style="padding-top:24px;"><a href="${url}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-size:15px;">Read the post</a></td></tr>
</table>
<p style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;color:#888;margin:16px 0 0;">You're getting this because you subscribed at ${escape(siteName)}. <a href="{{ unsubscribe }}" style="color:#888;">Unsubscribe</a></p>
</td></tr></table></body></html>`;
}

export const POST: APIRoute = async ({ request, url, locals }) => {
	const env = ((locals as any).runtime?.env ?? {}) as Env;

	// Fails closed: without a token configured, nobody can trigger a send.
	const token = env.NOTIFY_TOKEN;
	const given = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
	if (!token || !same(given, token)) return json({ error: "unauthorized" }, 401);

	const apiKey = env.BREVO_API_KEY;
	const listId = Number(env.BREVO_LIST_ID);
	if (!apiKey || !listId || !env.ASSETS) return json({ error: "not_configured" }, 503);
	const dry = url.searchParams.get("dry") === "1";
	const brevo = (path: string, init?: RequestInit) =>
		fetch(`https://api.brevo.com/v3${path}`, {
			...init,
			headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
		});

	// 1. Recent posts from the deployed feed.
	const rss = await env.ASSETS.fetch(new URL("/rss.xml", url.origin));
	if (!rss.ok) return json({ error: "rss_unavailable", status: rss.status }, 502);
	const xml = await rss.text();
	const siteName = decode(xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? url.hostname);
	const recent = parseRss(xml).filter((p) => !ALREADY_LIVE.has(p.slug));
	if (recent.length === 0) return json({ ok: true, sent: [], skipped: [], note: "no new posts" });

	// 2. Which of them already have a campaign.
	const existing = new Set<string>();
	for (let offset = 0; offset < 1000; offset += 100) {
		const res = await brevo(`/emailCampaigns?limit=100&offset=${offset}&sort=desc&excludeHtmlContent=true`);
		if (!res.ok) return json({ error: "brevo_campaigns", status: res.status }, 502);
		const { campaigns = [] } = (await res.json()) as { campaigns?: { name: string }[] };
		campaigns.forEach((c) => existing.add(c.name));
		if (campaigns.length < 100) break;
	}
	const todo = recent.filter((p) => !existing.has(`New post: ${p.slug}`));
	const skipped = recent.filter((p) => existing.has(`New post: ${p.slug}`)).map((p) => p.slug);
	if (dry || todo.length === 0) return json({ ok: true, dry, wouldSend: todo.map((p) => p.slug), skipped });

	// 3. Sender: configured, or the first active verified sender on the Brevo account.
	let sender: { email: string; name: string } | undefined = env.BREVO_SENDER_EMAIL
		? { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME || siteName }
		: undefined;
	if (!sender) {
		const res = await brevo("/senders");
		const { senders = [] } = (await res.json().catch(() => ({}))) as { senders?: { email: string; name: string; active: boolean }[] };
		const s = senders.find((x) => x.active);
		if (!s) return json({ error: "no_verified_sender" }, 503);
		sender = { email: s.email, name: env.BREVO_SENDER_NAME || s.name || siteName };
	}

	// 4. One campaign per post, sent now. Oldest first so inboxes read in order.
	const sent: string[] = [];
	const failed: { slug: string; step: string; status: number }[] = [];
	for (const post of todo.sort((a, b) => a.pubDate.valueOf() - b.pubDate.valueOf())) {
		const create = await brevo("/emailCampaigns", {
			method: "POST",
			body: JSON.stringify({
				name: `New post: ${post.slug}`,
				subject: post.title,
				previewText: post.description.slice(0, 140),
				sender,
				htmlContent: emailHtml(post, siteName),
				recipients: { listIds: [listId] },
			}),
		});
		if (!create.ok) {
			failed.push({ slug: post.slug, step: "create", status: create.status });
			console.error("Brevo create campaign failed", create.status, await create.text().catch(() => ""));
			continue;
		}
		const { id } = (await create.json()) as { id: number };
		const send = await brevo(`/emailCampaigns/${id}/sendNow`, { method: "POST" });
		if (!send.ok) {
			failed.push({ slug: post.slug, step: "send", status: send.status });
			console.error("Brevo sendNow failed", send.status, await send.text().catch(() => ""));
			continue;
		}
		sent.push(post.slug);
	}

	return json({ ok: failed.length === 0, sent, skipped, failed }, failed.length ? 502 : 200);
};

export const ALL: APIRoute = () => json({ error: "method_not_allowed" }, 405);

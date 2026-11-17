import type { APIRoute } from "astro";

// On-demand route: per-post view counts stored in Cloudflare D1 (binding `DB`, see VIEWS.md).
// GET  /api/views?slug=<slug>  -> { views }
// POST /api/views {slug}       -> counts one view, returns { views }
// Without the DB binding every call returns { views: null } and the page hides the count.
export const prerender = false;

const json = (body: Record<string, unknown>, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const SLUG = /^[a-z0-9][a-z0-9-]{0,150}$/;

type D1 = {
	prepare(sql: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> }; run(): Promise<unknown> };
};

let ready: Promise<unknown> | undefined;
const ensureTable = (db: D1) =>
	(ready ??= db
		.prepare("CREATE TABLE IF NOT EXISTS views (slug TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)")
		.run()
		.catch((e) => {
			ready = undefined;
			throw e;
		}));

const getEnv = (locals: unknown) => ((locals as any).runtime?.env ?? {}) as { DB?: D1; ASSETS?: { fetch: typeof fetch } };

async function current(db: D1, slug: string) {
	const row = await db.prepare("SELECT count FROM views WHERE slug = ?").bind(slug).first<{ count: number }>();
	return row?.count ?? 0;
}

export const GET: APIRoute = async ({ url, locals }) => {
	const { DB } = getEnv(locals);
	const slug = url.searchParams.get("slug") ?? "";
	if (!SLUG.test(slug)) return json({ error: "bad_slug" }, 400);
	if (!DB) return json({ views: null });
	await ensureTable(DB);
	return json({ views: await current(DB, slug) });
};

export const POST: APIRoute = async ({ request, url, locals }) => {
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);

	const { DB, ASSETS } = getEnv(locals);
	let slug = "";
	try {
		slug = String(((await request.json()) as { slug?: unknown }).slug ?? "");
	} catch {
		return json({ error: "bad_request" }, 400);
	}
	if (!SLUG.test(slug)) return json({ error: "bad_slug" }, 400);
	if (!DB) return json({ views: null });
	await ensureTable(DB);

	// Only count posts that exist, so random slugs can't fill the table. Checked once, on a post's first view.
	const existing = await DB.prepare("SELECT count FROM views WHERE slug = ?").bind(slug).first<{ count: number }>();
	if (!existing) {
		const page = ASSETS ? await ASSETS.fetch(new URL(`/blog/${slug}/`, url.origin)) : undefined;
		if (page && !page.ok) return json({ error: "not_found" }, 404);
	}

	await DB.prepare("INSERT INTO views (slug, count) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET count = count + 1")
		.bind(slug)
		.run();
	return json({ views: await current(DB, slug) });
};

export const ALL: APIRoute = () => json({ error: "method_not_allowed" }, 405);

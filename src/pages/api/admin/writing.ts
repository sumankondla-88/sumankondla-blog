import type { APIRoute } from "astro";

export const prerender = false;

type WritingRequest = {
	mode?: unknown;
	topic?: unknown;
	audience?: unknown;
	category?: unknown;
	notes?: unknown;
	title?: unknown;
	content?: unknown;
};

const json = (body: Record<string, unknown>, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});

function text(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function safeJson(value: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export const POST: APIRoute = async ({ request, locals, url }) => {
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
	if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
		return json({ error: "content_type_required" }, 415);
	}
	const length = Number(request.headers.get("Content-Length") ?? 0);
	if (length > 40_000) return json({ error: "request_too_large" }, 413);

	let input: WritingRequest;
	try {
		input = await request.json();
	} catch {
		return json({ error: "bad_request" }, 400);
	}

	const mode = input.mode;
	if (mode !== "draft" && mode !== "seo") return json({ error: "invalid_mode" }, 400);

	const topic = text(input.topic, 300);
	const audience = text(input.audience, 300);
	const category = text(input.category, 100);
	const notes = text(input.notes, 4_000);
	const title = text(input.title, 180);
	const content = text(input.content, 30_000);

	if (mode === "draft" && !topic) return json({ error: "topic_required" }, 400);
	if (mode === "seo" && (!title || !content)) return json({ error: "title_and_content_required" }, 400);
	if (
		(input.topic !== undefined && input.topic !== null && typeof input.topic !== "string") ||
		(typeof input.topic === "string" && input.topic.length > 300) ||
		(typeof input.audience === "string" && input.audience.length > 300) ||
		(typeof input.category === "string" && input.category.length > 100) ||
		(typeof input.notes === "string" && input.notes.length > 4_000) ||
		(typeof input.title === "string" && input.title.length > 180) ||
		(typeof input.content === "string" && input.content.length > 30_000)
	) {
		return json({ error: "input_too_long" }, 400);
	}

	const env = locals.runtime.env as Env & { ANTHROPIC_API_KEY?: string; ANTHROPIC_MODEL?: string };
	const apiKey = env.ANTHROPIC_API_KEY ?? import.meta.env.ANTHROPIC_API_KEY;
	if (!apiKey) return json({ error: "anthropic_not_configured" }, 503);

	const system =
		"You are an editorial assistant for a practical cloud architecture blog. Write clear, technically careful material. Do not invent benchmarks, product behavior, or citations. Mark assumptions and recommend verification for fast-changing product details. Return only a valid JSON object with string properties: title, description, seoTitle, seoDescription, markdown. Keep title under 70 characters, description and seoDescription under 180 characters, and seoTitle under 70 characters. For SEO mode, leave markdown empty. For draft mode, create a useful article in Markdown with a concise introduction, descriptive headings, practical guidance, and a closing summary. Do not include frontmatter or HTML.";
	const user =
		mode === "draft"
			? `Create an unpublished article draft.\nTopic: ${topic}\nTarget audience: ${audience ?? "cloud practitioners"}\nCategory/context: ${category ?? "cloud infrastructure"}\nAuthor notes and required points: ${notes ?? "Use your judgment; do not claim personal experience on behalf of the author."}\nWrite an original, useful draft and metadata.`
			: `Suggest SEO metadata for this existing article. Do not rewrite the article.\nTitle: ${title}\nArticle content:\n${content}`;

	let response: Response;
	try {
		response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
				max_tokens: mode === "draft" ? 6_000 : 800,
				system,
				messages: [{ role: "user", content: user }],
			}),
		});
	} catch (error) {
		console.error("Anthropic request failed", error);
		return json({ error: "provider_unavailable" }, 502);
	}

	if (!response.ok) {
		console.error("Anthropic API error", response.status);
		return json({ error: response.status === 429 ? "provider_rate_limited" : "provider_error" }, response.status === 429 ? 429 : 502);
	}

	let providerData: { content?: Array<{ type?: string; text?: string }> };
	try {
		providerData = await response.json();
	} catch (error) {
		console.error("Invalid Anthropic response", error);
		return json({ error: "invalid_provider_response" }, 502);
	}
	const output = providerData.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
	const result = output ? safeJson(output.replace(/^```(?:json)?\s*|\s*```$/g, "")) : undefined;
	if (!result) return json({ error: "invalid_provider_response" }, 502);

	const fields = ["title", "description", "seoTitle", "seoDescription", "markdown"] as const;
	if (fields.some((field) => typeof result[field] !== "string")) {
		console.error("Anthropic response omitted required writing fields");
		return json({ error: "invalid_provider_response" }, 502);
	}

	return json({ result });
};

export const ALL: APIRoute = () => json({ error: "method_not_allowed" }, 405);

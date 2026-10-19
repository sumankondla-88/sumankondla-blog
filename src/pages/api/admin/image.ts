import type { APIRoute } from "astro";

export const prerender = false;

const json = (body: Record<string, unknown>, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});

export const POST: APIRoute = async ({ request, locals, url }) => {
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
	if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
		return json({ error: "content_type_required" }, 415);
	}
	const length = Number(request.headers.get("Content-Length") ?? 0);
	if (length > 8_000) return json({ error: "request_too_large" }, 413);

	let input: { prompt?: unknown };
	try {
		input = await request.json();
	} catch {
		return json({ error: "bad_request" }, 400);
	}
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt) return json({ error: "prompt_required" }, 400);
	if (prompt.length > 2_000) return json({ error: "prompt_too_long" }, 400);

	const env = locals.runtime.env as Env & { OPENAI_API_KEY?: string; OPENAI_IMAGE_MODEL?: string };
	const apiKey = env.OPENAI_API_KEY ?? import.meta.env.OPENAI_API_KEY;
	if (!apiKey) return json({ error: "openai_not_configured" }, 503);

	let response: Response;
	try {
		response = await fetch("https://api.openai.com/v1/images/generations", {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-flare",
				prompt: `${prompt}\nCreate a polished, landscape 3:2 editorial illustration for a cloud architecture blog. No words, labels, watermarks, or logos.`,
				size: "1536x1024",
				quality: "medium",
				output_format: "png",
			}),
		});
	} catch (error) {
		console.error("OpenAI image request failed", error);
		return json({ error: "provider_unavailable" }, 502);
	}

	if (!response.ok) {
		console.error("OpenAI image API error", response.status);
		return json({ error: response.status === 429 ? "provider_rate_limited" : "provider_error" }, response.status === 429 ? 429 : 502);
	}

	let providerData: { data?: Array<{ b64_json?: string }> };
	try {
		providerData = await response.json();
	} catch (error) {
		console.error("Invalid OpenAI image response", error);
		return json({ error: "invalid_provider_response" }, 502);
	}
	const image = providerData.data?.[0]?.b64_json;
	if (!image || image.length > 25_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
		console.error("OpenAI image response did not contain a valid image");
		return json({ error: "invalid_provider_response" }, 502);
	}

	return json({ image, mimeType: "image/png" });
};

export const ALL: APIRoute = () => json({ error: "method_not_allowed" }, 405);

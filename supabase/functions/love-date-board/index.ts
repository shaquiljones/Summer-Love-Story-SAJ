import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_ORIGIN = "https://shaquiljones.github.io";
// Set via `supabase secrets set LOVE_DATE_BOARD_KEY=...` — never hardcode it here.
const BOARD_KEY = Deno.env.get("LOVE_DATE_BOARD_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false } },
);

type ActivityInput = {
  title?: unknown;
  sourceUrl?: unknown;
  plannedFor?: unknown;
  submittedBy?: unknown;
};

function headers(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": SITE_ORIGIN,
    "Access-Control-Allow-Headers": "content-type, x-activity-board-key",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function validUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function metaTag(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].replace(/&amp;/g, "&").trim();
  }
  return "";
}

async function getPreview(sourceUrl: string) {
  let previewTitle = "";
  let previewImageUrl = "";
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(sourceUrl)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; DreaShaqDateBoard/1.0)" },
      });
      if (oembed.ok) {
        const data = await oembed.json();
        previewTitle = cleanText(data?.title, 180);
        previewImageUrl = validUrl(String(data?.thumbnail_url ?? "")) ? String(data.thumbnail_url) : "";
      }
    }

    if (!previewImageUrl || !previewTitle) {
      const response = await fetch(sourceUrl, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; DreaShaqDateBoard/1.0; +https://shaquiljones.github.io/Summer-Love-Story-SAJ/)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok && contentType.includes("text/html")) {
        const html = (await response.text()).slice(0, 700_000);
        previewTitle ||= cleanText(metaTag(html, "og:title") || metaTag(html, "twitter:title") || "", 180);
        const rawImage = metaTag(html, "og:image") || metaTag(html, "twitter:image") || "";
        if (!previewImageUrl && rawImage) {
          try { previewImageUrl = new URL(rawImage, response.url).href; } catch { /* use the card fallback */ }
        }
      }
    }
  } catch {
    // A fallback card is shown when a social platform blocks preview scraping.
  }
  return { previewTitle, previewImageUrl };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (origin && origin !== SITE_ORIGIN) return json({ error: "This board only accepts requests from the Summer Love Story site." }, 403, origin);
  if (!BOARD_KEY || req.headers.get("x-activity-board-key") !== BOARD_KEY) return json({ error: "That board key did not match." }, 401, origin);

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("shared_date_ideas")
      .select("id,title,source_url,planned_for,submitted_by,preview_image_url,preview_title,created_at")
      .order("planned_for", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) return json({ error: "Could not load the activity board." }, 500, origin);
    return json({ activities: data ?? [] }, 200, origin);
  }

  if (req.method === "POST") {
    let input: ActivityInput;
    try { input = await req.json(); } catch { return json({ error: "Please send a valid activity." }, 400, origin); }
    const title = cleanText(input.title, 100);
    const sourceUrl = cleanText(input.sourceUrl, 2000);
    const plannedFor = cleanText(input.plannedFor, 10);
    const submittedBy = cleanText(input.submittedBy, 10);
    if (!title) return json({ error: "Give this activity a name." }, 400, origin);
    if (!validUrl(sourceUrl)) return json({ error: "Paste a full website, TikTok, or Instagram link." }, 400, origin);
    if (plannedFor && !/^\d{4}-\d{2}-\d{2}$/.test(plannedFor)) return json({ error: "Choose a valid date." }, 400, origin);
    if (submittedBy !== "Shaq" && submittedBy !== "Drea") return json({ error: "Choose who added it." }, 400, origin);

    const preview = await getPreview(sourceUrl);
    const { data, error } = await supabase
      .from("shared_date_ideas")
      .insert({
        title,
        source_url: sourceUrl,
        planned_for: plannedFor || null,
        submitted_by: submittedBy,
        preview_image_url: preview.previewImageUrl || null,
        preview_title: preview.previewTitle || null,
      })
      .select("id,title,source_url,planned_for,submitted_by,preview_image_url,preview_title,created_at")
      .single();
    if (error) return json({ error: "Could not save that activity." }, 500, origin);
    return json({ activity: data }, 201, origin);
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json({ error: "That activity could not be found." }, 400, origin);
    const { error } = await supabase.from("shared_date_ideas").delete().eq("id", id);
    if (error) return json({ error: "Could not remove that activity." }, 500, origin);
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "Method not allowed." }, 405, origin);
});

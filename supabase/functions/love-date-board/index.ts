import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE_ORIGIN = "https://shaquiljones.github.io";
// Set via `supabase secrets set LOVE_DATE_BOARD_KEY=...` — never hardcode it here.
const BOARD_KEY = Deno.env.get("LOVE_DATE_BOARD_KEY") ?? "";
const PHOTOS_BUCKET = "date-photos";
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

type PhotoInput = {
  imageBase64?: unknown;
  caption?: unknown;
  takenOn?: unknown;
};

type CalendarInput = {
  eventDate?: unknown;
  title?: unknown;
  eventTime?: unknown;
  category?: unknown;
};

type RestaurantInput = {
  name?: unknown;
  addr?: unknown;
  description?: unknown;
  link?: unknown;
};

type MovieInput = {
  title?: unknown;
  posterUrl?: unknown;
  addedBy?: unknown;
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

// TikTok/Instagram preview images are signed CDN URLs that expire after a
// while (by platform design, for anti-hotlinking). Download the bytes once
// at creation time and re-host them in our own public bucket so the
// thumbnail never goes stale/403s down the line.
async function rehostPreviewImage(ideaId: string, sourceUrl: string, imageUrl: string) {
  try {
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DreaShaqDateBoard/1.0; +https://shaquiljones.github.io/Summer-Love-Story-SAJ/)",
        "Referer": sourceUrl,
      },
    });
    if (!response.ok) return imageUrl;
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) return imageUrl;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 8_000_000) return imageUrl;

    const storagePath = `idea-thumbs/${ideaId}.jpg`;
    const upload = await supabase.storage.from(PHOTOS_BUCKET).upload(storagePath, bytes, {
      contentType,
      upsert: true,
    });
    if (upload.error) return imageUrl;

    const { data: pub } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(storagePath);
    return pub.publicUrl || imageUrl;
  } catch {
    return imageUrl;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ["Date Night", "Dinner", "Fun/Outing", "Trip"];
// Resized client-side to max-width 900px @ JPEG q0.82 before upload, so a
// generous ceiling here is just abuse protection, not a normal-use limit.
const MAX_BASE64_LEN = 8_000_000;

function parseId(req: Request) {
  return new URL(req.url).searchParams.get("id") ?? "";
}

// ---------- shared_date_ideas (Add Activity board) ----------

async function handleIdeas(req: Request, origin: string | null) {
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
    if (plannedFor && !DATE_RE.test(plannedFor)) return json({ error: "Choose a valid date." }, 400, origin);
    if (submittedBy !== "Shaq" && submittedBy !== "Drea") return json({ error: "Choose who added it." }, 400, origin);

    const preview = await getPreview(sourceUrl);
    const ideaId = crypto.randomUUID();
    const hostedImageUrl = preview.previewImageUrl
      ? await rehostPreviewImage(ideaId, sourceUrl, preview.previewImageUrl)
      : "";
    const { data, error } = await supabase
      .from("shared_date_ideas")
      .insert({
        id: ideaId,
        title,
        source_url: sourceUrl,
        planned_for: plannedFor || null,
        submitted_by: submittedBy,
        preview_image_url: hostedImageUrl || preview.previewImageUrl || null,
        preview_title: preview.previewTitle || null,
      })
      .select("id,title,source_url,planned_for,submitted_by,preview_image_url,preview_title,created_at")
      .single();
    if (error) return json({ error: "Could not save that activity." }, 500, origin);
    return json({ activity: data }, 201, origin);
  }

  if (req.method === "DELETE") {
    const id = parseId(req);
    if (!UUID_RE.test(id)) return json({ error: "That activity could not be found." }, 400, origin);
    const { error } = await supabase.from("shared_date_ideas").delete().eq("id", id);
    if (error) return json({ error: "Could not remove that activity." }, 500, origin);
    await supabase.storage.from(PHOTOS_BUCKET).remove([`idea-thumbs/${id}.jpg`]);
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "Method not allowed." }, 405, origin);
}

// ---------- shared_photos (Photo Book) ----------

async function handlePhotos(req: Request, origin: string | null) {
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("shared_photos")
      .select("id,src_url,caption,taken_on,created_at")
      .order("created_at", { ascending: true });
    if (error) return json({ error: "Could not load the photo book." }, 500, origin);
    return json({ photos: data ?? [] }, 200, origin);
  }

  if (req.method === "POST") {
    let raw: string;
    try { raw = await req.text(); } catch { return json({ error: "Please send a valid photo." }, 400, origin); }
    if (raw.length > MAX_BASE64_LEN) return json({ error: "That photo is too large." }, 413, origin);
    let input: PhotoInput;
    try { input = JSON.parse(raw); } catch { return json({ error: "Please send a valid photo." }, 400, origin); }

    const imageBase64 = typeof input.imageBase64 === "string" ? input.imageBase64 : "";
    const caption = cleanText(input.caption, 120);
    const takenOn = cleanText(input.takenOn, 10);
    if (takenOn && !DATE_RE.test(takenOn)) return json({ error: "Choose a valid date." }, 400, origin);

    const match = imageBase64.match(/^data:(image\/(?:jpeg|png|webp));base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) return json({ error: "Please attach a photo." }, 400, origin);
    const [, mime, b64] = match;
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

    let bytes: Uint8Array;
    try {
      const binary = atob(b64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch {
      return json({ error: "That photo could not be read." }, 400, origin);
    }
    if (bytes.length > 6_000_000) return json({ error: "That photo is too large." }, 413, origin);

    const storagePath = `photos/${crypto.randomUUID()}.${ext}`;
    const upload = await supabase.storage.from(PHOTOS_BUCKET).upload(storagePath, bytes, {
      contentType: mime,
      upsert: false,
    });
    if (upload.error) return json({ error: "Could not upload that photo." }, 500, origin);

    const { data: pub } = supabase.storage.from(PHOTOS_BUCKET).getPublicUrl(storagePath);
    const { data, error } = await supabase
      .from("shared_photos")
      .insert({
        src_url: pub.publicUrl,
        caption: caption || null,
        taken_on: takenOn || null,
        storage_path: storagePath,
      })
      .select("id,src_url,caption,taken_on,created_at")
      .single();
    if (error) {
      await supabase.storage.from(PHOTOS_BUCKET).remove([storagePath]);
      return json({ error: "Could not save that photo." }, 500, origin);
    }
    return json({ photo: data }, 201, origin);
  }

  if (req.method === "DELETE") {
    const id = parseId(req);
    if (!UUID_RE.test(id)) return json({ error: "That photo could not be found." }, 400, origin);
    const { data: row } = await supabase.from("shared_photos").select("storage_path").eq("id", id).single();
    const { error } = await supabase.from("shared_photos").delete().eq("id", id);
    if (error) return json({ error: "Could not remove that photo." }, 500, origin);
    if (row?.storage_path) await supabase.storage.from(PHOTOS_BUCKET).remove([row.storage_path]);
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "Method not allowed." }, 405, origin);
}

// ---------- shared_calendar_events (Calendar) ----------

async function handleCalendar(req: Request, origin: string | null) {
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("shared_calendar_events")
      .select("id,event_date,title,event_time,category,created_at")
      .order("event_date", { ascending: true });
    if (error) return json({ error: "Could not load the calendar." }, 500, origin);
    return json({ events: data ?? [] }, 200, origin);
  }

  if (req.method === "POST") {
    let input: CalendarInput;
    try { input = await req.json(); } catch { return json({ error: "Please send a valid event." }, 400, origin); }
    const eventDate = cleanText(input.eventDate, 10);
    const title = cleanText(input.title, 100);
    const eventTime = cleanText(input.eventTime, 5);
    const category = cleanText(input.category, 20);
    if (!DATE_RE.test(eventDate)) return json({ error: "Choose a valid date." }, 400, origin);
    if (!title) return json({ error: "Give this event a title." }, 400, origin);
    if (!CATEGORIES.includes(category)) return json({ error: "Choose a valid category." }, 400, origin);

    const { data, error } = await supabase
      .from("shared_calendar_events")
      .insert({ event_date: eventDate, title, event_time: eventTime || null, category })
      .select("id,event_date,title,event_time,category,created_at")
      .single();
    if (error) return json({ error: "Could not save that event." }, 500, origin);
    return json({ event: data }, 201, origin);
  }

  if (req.method === "DELETE") {
    const id = parseId(req);
    if (!UUID_RE.test(id)) return json({ error: "That event could not be found." }, 400, origin);
    const { error } = await supabase.from("shared_calendar_events").delete().eq("id", id);
    if (error) return json({ error: "Could not remove that event." }, 500, origin);
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "Method not allowed." }, 405, origin);
}

// ---------- shared_restaurants (Eats) ----------

async function handleRestaurants(req: Request, origin: string | null) {
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("shared_restaurants")
      .select("id,name,addr,description,link,created_at")
      .order("created_at", { ascending: true });
    if (error) return json({ error: "Could not load the eats list." }, 500, origin);
    return json({ restaurants: data ?? [] }, 200, origin);
  }

  if (req.method === "POST") {
    let input: RestaurantInput;
    try { input = await req.json(); } catch { return json({ error: "Please send a valid restaurant." }, 400, origin); }
    const name = cleanText(input.name, 100);
    const addr = cleanText(input.addr, 100);
    const description = cleanText(input.description, 240);
    const link = cleanText(input.link, 2000);
    if (!name) return json({ error: "Give this spot a name." }, 400, origin);
    if (link && !validUrl(link)) return json({ error: "That link doesn't look valid." }, 400, origin);

    const { data, error } = await supabase
      .from("shared_restaurants")
      .insert({ name, addr: addr || null, description: description || null, link: link || null })
      .select("id,name,addr,description,link,created_at")
      .single();
    if (error) return json({ error: "Could not save that restaurant." }, 500, origin);
    return json({ restaurant: data }, 201, origin);
  }

  if (req.method === "DELETE") {
    const id = parseId(req);
    if (!UUID_RE.test(id)) return json({ error: "That restaurant could not be found." }, 400, origin);
    const { error } = await supabase.from("shared_restaurants").delete().eq("id", id);
    if (error) return json({ error: "Could not remove that restaurant." }, 500, origin);
    return json({ ok: true }, 200, origin);
  }

  return json({ error: "Method not allowed." }, 405, origin);
}

// ---------- shared_movies (Movie List) ----------

async function handleMovies(req: Request, origin: string | null) {
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("shared_movies")
      .select("id,title,poster_url,added_by,watched,created_at")
      .order("created_at", { ascending: false });
    if (error) return json({ error: "Could not load the movie list." }, 500, origin);
    return json({ movies: data ?? [] }, 200, origin);
  }

  if (req.method === "POST") {
    let input: MovieInput;
    try { input = await req.json(); } catch { return json({ error: "Please send a valid movie." }, 400, origin); }
    const title = cleanText(input.title, 150);
    const posterUrl = cleanText(input.posterUrl, 2000);
    const addedBy = cleanText(input.addedBy, 10);
    if (!title) return json({ error: "Give the movie a title." }, 400, origin);
    if (posterUrl && !validUrl(posterUrl)) return json({ error: "That poster link doesn't look valid." }, 400, origin);
    if (addedBy && addedBy !== "Shaq" && addedBy !== "Drea") return json({ error: "Choose who added it." }, 400, origin);

    const { data, error } = await supabase
      .from("shared_movies")
      .insert({ title, poster_url: posterUrl || null, added_by: addedBy || null })
      .select("id,title,poster_url,added_by,watched,created_at")
      .single();
    if (error) return json({ error: "Could not save that movie." }, 500, origin);
    return json({ movie: data }, 201, origin);
  }

  if (req.method === "DELETE") {
    const id = parseId(req);
    if (!UUID_RE.test(id)) return json({ error: "That movie could not be found." }, 400, origin);
    const { error } = await supabase.from("shared_movies").delete().eq("id", id);
    if (error) return json({ error: "Could not remove that movie." }, 500, origin);
    return json({ ok: true }, 200, origin);
  }

  if (req.method === "PATCH") {
    const id = parseId(req);
    if (!UUID_RE.test(id)) return json({ error: "That movie could not be found." }, 400, origin);
    let input: { watched?: unknown };
    try { input = await req.json(); } catch { return json({ error: "Please send a valid update." }, 400, origin); }
    const { data, error } = await supabase
      .from("shared_movies")
      .update({ watched: Boolean(input.watched) })
      .eq("id", id)
      .select("id,title,poster_url,added_by,watched,created_at")
      .single();
    if (error) return json({ error: "Could not update that movie." }, 500, origin);
    return json({ movie: data }, 200, origin);
  }

  return json({ error: "Method not allowed." }, 405, origin);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (origin && origin !== SITE_ORIGIN) return json({ error: "This board only accepts requests from the Summer Love Story site." }, 403, origin);
  if (!BOARD_KEY || req.headers.get("x-activity-board-key") !== BOARD_KEY) return json({ error: "That board key did not match." }, 401, origin);

  const type = new URL(req.url).searchParams.get("type") ?? "ideas";
  switch (type) {
    case "ideas": return handleIdeas(req, origin);
    case "photos": return handlePhotos(req, origin);
    case "calendar": return handleCalendar(req, origin);
    case "restaurants": return handleRestaurants(req, origin);
    case "movies": return handleMovies(req, origin);
    default: return json({ error: "Unknown resource type." }, 400, origin);
  }
});

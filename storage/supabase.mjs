import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BUCKET = process.env.SUPABASE_BUCKET || "mylist-data";

export async function putJSON(path, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, body, {
      upsert: true,
      contentType: "application/json"
    });

  if (error) throw error;
}

export async function getJSON(path) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(path);

  if (error) return null;

  const text = await data.text();
  return JSON.parse(text);
}

export async function deleteJSON(path) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([path]);

  if (error) throw error;
}

export async function listJSON(prefix) {
  const out = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });

    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0) break;

    for (const entry of data) {
      const name = String(entry?.name || "");
      if (!name.endsWith(".json")) continue;
      if (name === "index.json") continue;
      out.push(`${prefix}/${name}`);
    }

    if (data.length < 100) break;
    offset += data.length;
  }

  return out;
}

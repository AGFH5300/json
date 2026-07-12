import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const ACCESS = "precision-sign-review-20260712-51c7a6e4";
Deno.serve(async (req: Request) => {
  try {
    const u = new URL(req.url);
    if (u.searchParams.get("access") !== ACCESS) return new Response("Forbidden", { status: 403 });
    const paper = String(u.searchParams.get("paper") || "").toUpperCase();
    const type = String(u.searchParams.get("type") || "").toLowerCase();
    if (!/^[MN]\d{2}$/.test(paper) || !["question", "markscheme"].includes(type)) return new Response("Bad parameters", { status: 400 });
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const path = `_precision_crop_review/${paper}_${type}.zip`;
    const { data, error } = await sb.storage.from("question-assets").createSignedUrl(path, 3600);
    if (error) throw error;
    return Response.json({ paper, type, path, signed_url: data.signedUrl });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});

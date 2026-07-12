import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as mupdf from "npm:mupdf@1.27.0";
import { PNG } from "npm:pngjs@7.0.0";
import { Buffer } from "node:buffer";

const ACCESS = "precision-render-20260712-6d924e8a";

function cropPng(source: PNG, x: number, y: number, width: number, height: number): PNG {
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > source.width || y + height > source.height) {
    throw new Error(`Crop outside source: ${x},${y},${width},${height} on ${source.width}x${source.height}`);
  }
  const out = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * source.width + x) * 4;
    out.data.set(source.data.subarray(start, start + width * 4), row * width * 4);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();
    if (body.access !== ACCESS) return new Response("Forbidden", { status: 403 });
    const paperCode = String(body.paper_code || "").toUpperCase();
    const assetType = String(body.asset_type || "").toLowerCase();
    const offset = Math.max(0, Number(body.offset || 0));
    const limit = Math.min(20, Math.max(1, Number(body.limit || 10)));
    if (!/^[MN]\d{2}$/.test(paperCode) || !["question", "markscheme"].includes(assetType)) return Response.json({ error: "Invalid parameters" }, { status: 400 });

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: registry, error: re } = await sb.from("audit_source_registry").select("drive_id").eq("paper_code", paperCode).eq("asset_type", assetType).single();
    if (re || !registry) throw re || new Error("Source registry missing");
    const { data: plan, error: pe } = await sb.from("precision_crop_plan")
      .select("id,question_number,sort_order,source_page,crop_x,crop_y,crop_width,crop_height,storage_path")
      .eq("paper_code", paperCode).eq("asset_type", assetType).eq("status", "pending").order("id").range(offset, offset + limit - 1);
    if (pe) throw pe;
    if (!plan?.length) return Response.json({ paper_code: paperCode, asset_type: assetType, offset, processed: 0 });

    const sourceResponse = await fetch(`https://drive.usercontent.google.com/download?id=${registry.drive_id}&export=download&confirm=t`, { redirect: "follow" });
    if (!sourceResponse.ok) throw new Error(`Drive download failed: ${sourceResponse.status}`);
    const document = mupdf.Document.openDocument(new Uint8Array(await sourceResponse.arrayBuffer()), "application/pdf");
    const cache = new Map<number, PNG>();
    const getPage = (pageNumber: number): PNG => {
      if (cache.has(pageNumber)) return cache.get(pageNumber)!;
      const pixmap = document.loadPage(pageNumber - 1).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
      const png = PNG.sync.read(Buffer.from(pixmap.asPNG()));
      cache.set(pageNumber, png);
      return png;
    };

    const results: any[] = [];
    for (const row of plan) {
      try {
        const source = getPage(row.source_page);
        const cropped = cropPng(source, row.crop_x, row.crop_y, row.crop_width, row.crop_height);
        const encoded = PNG.sync.write(cropped);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))).map(b => b.toString(16).padStart(2, "0")).join("");
        const { error: ue } = await sb.storage.from("question-assets").upload(row.storage_path, new Blob([encoded], { type: "image/png" }), { upsert: true, contentType: "image/png", cacheControl: "31536000" });
        if (ue) throw ue;
        const verification = { source_width: source.width, source_height: source.height, output_width: cropped.width, output_height: cropped.height, bytes: encoded.byteLength, sha256: digest, rendered_at: new Date().toISOString() };
        const { error: ve } = await sb.from("precision_crop_plan").update({ status: "rendered", verification }).eq("id", row.id);
        if (ve) throw ve;
        results.push({ id: row.id, question_number: row.question_number, sort_order: row.sort_order, path: row.storage_path, ok: true, ...verification });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await sb.from("precision_crop_plan").update({ status: "error", verification: { error: message } }).eq("id", row.id);
        results.push({ id: row.id, question_number: row.question_number, sort_order: row.sort_order, path: row.storage_path, ok: false, error: message });
      }
    }
    return Response.json({ paper_code: paperCode, asset_type: assetType, offset, requested: plan.length, processed: results.length, failures: results.filter(r => !r.ok).length, results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
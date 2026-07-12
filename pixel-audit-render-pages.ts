import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as mupdf from "npm:mupdf@1.27.0";

const ACCESS = "atlas-render-complete-pages-20260712";

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();
    if (body.access !== ACCESS) return new Response("Forbidden", { status: 403 });
    const paperCode = String(body.paper_code || "").toUpperCase();
    const assetType = String(body.asset_type || "");
    const driveId = String(body.drive_id || "");
    if (!/^[MN]\d{2}$/.test(paperCode) || !["question", "markscheme"].includes(assetType) || !driveId) {
      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }
    const sourceResponse = await fetch(`https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`, { redirect: "follow" });
    if (!sourceResponse.ok) throw new Error(`Drive download failed: ${sourceResponse.status}`);
    const document = mupdf.Document.openDocument(new Uint8Array(await sourceResponse.arrayBuffer()), "application/pdf");
    const fromPage = Math.max(1, Number(body.page_from || 1));
    const toPage = Math.min(document.countPages(), Number(body.page_to || document.countPages()));
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const results: any[] = [];
    for (let pageNumber = fromPage; pageNumber <= toPage; pageNumber++) {
      const page = document.loadPage(pageNumber - 1);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false);
      let bytes: Uint8Array;
      let extension: string;
      let contentType: string;
      try {
        bytes = pixmap.asJPEG(88);
        extension = "jpg";
        contentType = "image/jpeg";
      } catch {
        bytes = pixmap.asPNG();
        extension = "png";
        contentType = "image/png";
      }
      const path = `audit-full-pages/${paperCode.toLowerCase()}/${assetType}/page_${String(pageNumber).padStart(2, "0")}.${extension}`;
      const { error } = await sb.storage.from("question-assets").upload(path, bytes, { contentType, upsert: true, cacheControl: "31536000" });
      if (error) throw error;
      results.push({ page: pageNumber, path, bytes: bytes.byteLength });
    }
    return Response.json({ paper_code: paperCode, asset_type: assetType, page_count: document.countPages(), rendered: results.length, results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});

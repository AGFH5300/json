import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as mupdf from "npm:mupdf@1.27.0";
import { decodeImage, inkMask, locateCrop, edgeEvidence } from "./pixel-audit-matcher.ts";

const ACCESS = "atlas-page-search-20260712";
Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();
    if (body.access !== ACCESS) return new Response("Forbidden", { status: 403 });
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: blob, error: downloadError } = await sb.storage.from("question-assets").download(body.storage_path);
    if (downloadError || !blob) throw downloadError || new Error("Storage download failed");
    const assetImage = decodeImage(new Uint8Array(await blob.arrayBuffer()), body.storage_path);
    const assetMask = inkMask(assetImage);
    const sourceResponse = await fetch(`https://drive.usercontent.google.com/download?id=${body.drive_id}&export=download&confirm=t`, { redirect: "follow" });
    if (!sourceResponse.ok) throw new Error(`Drive download ${sourceResponse.status}`);
    const document = mupdf.Document.openDocument(new Uint8Array(await sourceResponse.arrayBuffer()), "application/pdf");
    const fromPage = Math.max(1, Number(body.page_from || 1));
    const toPage = Math.min(document.countPages(), Number(body.page_to || document.countPages()));
    let best: any = null;
    for (let pageNumber = fromPage; pageNumber <= toPage; pageNumber++) {
      const pixmap = document.loadPage(pageNumber - 1).toPixmap(mupdf.Matrix.scale(1.25, 1.25), mupdf.ColorSpace.DeviceRGB, false);
      const pageImage = decodeImage(pixmap.asPNG(), `source-page-${pageNumber}`);
      const pageMask = inkMask(pageImage);
      const crop = locateCrop(pageMask, pageImage.width, pageImage.height, assetMask, assetImage.width, assetImage.height);
      if (!best || crop.score > best.crop.score) best = { pageNumber, pageImage, pageMask, crop };
    }
    if (!best) throw new Error("No source page evaluated");
    const edge = edgeEvidence(best.pageMask, best.pageImage.width, best.pageImage.height, best.crop);
    const status = best.crop.score < 0.35 ? "unmatched" : best.crop.score < 0.55 ? "low_match" : edge.crossing > 12 ? "clipped" : "pass";
    const patch = {
      source_page: best.pageNumber, source_page_count: document.countPages(), decode_ok: true,
      asset_width: assetImage.width, asset_height: assetImage.height,
      source_width: best.pageImage.width, source_height: best.pageImage.height,
      match_score: best.crop.score, crop_x: best.crop.x, crop_y: best.crop.y,
      crop_width: best.crop.width, crop_height: best.crop.height,
      crossing_pixels: edge.crossing, adjacent_ink_top: edge.top, adjacent_ink_bottom: edge.bottom,
      adjacent_ink_left: edge.left, adjacent_ink_right: edge.right,
      status, details: { searched_pages: [fromPage, toPage], scale: best.crop.scale }
    };
    const { error: updateError } = await sb.from("pixel_audit_assets").update(patch)
      .eq("run_id", body.run_id).eq("storage_path", body.storage_path);
    if (updateError) throw updateError;
    return Response.json({ storage_path: body.storage_path, source_page: best.pageNumber, score: best.crop.score, status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});

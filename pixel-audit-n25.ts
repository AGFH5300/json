import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as mupdf from "npm:mupdf@1.27.0";
import { decodeImage, inkMask, locateCrop, edgeEvidence } from "./pixel-audit-matcher.ts";

const RUN_ID = "e46fe275-5ead-4385-85d5-bd247181f631";
const DRIVE_ID = "1LtX3WuF2M0CtN9twGlcM07BIQU0Zhz9l";
const TARGETS = [
  { path: "n25/1a/question/1a.png", from: 1, to: 2 },
  { path: "n25/1b/question/1b.png", from: 1, to: 2 },
  { path: "n25/2a/question/2a.png", from: 3, to: 4 },
  { path: "n25/2b/question/2b.png", from: 3, to: 4 },
  { path: "n25/2c/question/2c.png", from: 3, to: 4 },
];

Deno.serve(async () => {
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const sourceResponse = await fetch(`https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download&confirm=t`, { redirect: "follow" });
    if (!sourceResponse.ok) throw new Error(`Drive download ${sourceResponse.status}`);
    const document = mupdf.Document.openDocument(new Uint8Array(await sourceResponse.arrayBuffer()), "application/pdf");
    const pageCache = new Map<number, any>();
    const sourcePage = (number: number) => {
      if (pageCache.has(number)) return pageCache.get(number);
      const pixmap = document.loadPage(number - 1).toPixmap(mupdf.Matrix.scale(1.25, 1.25), mupdf.ColorSpace.DeviceRGB, false);
      const image = decodeImage(pixmap.asPNG(), `page-${number}`);
      const value = { image, mask: inkMask(image) };
      pageCache.set(number, value);
      return value;
    };
    const results: any[] = [];
    for (const target of TARGETS) {
      const { data: blob, error: downloadError } = await sb.storage.from("question-assets").download(target.path);
      if (downloadError || !blob) throw downloadError || new Error(`Missing ${target.path}`);
      const image = decodeImage(new Uint8Array(await blob.arrayBuffer()), target.path);
      const assetMask = inkMask(image);
      let best: any = null;
      for (let pageNumber = target.from; pageNumber <= target.to; pageNumber++) {
        const page = sourcePage(pageNumber);
        const crop = locateCrop(page.mask, page.image.width, page.image.height, assetMask, image.width, image.height);
        if (!best || crop.score > best.crop.score) best = { pageNumber, page, crop };
      }
      const edge = edgeEvidence(best.page.mask, best.page.image.width, best.page.image.height, best.crop);
      const status = best.crop.score < 0.35 ? "unmatched" : best.crop.score < 0.55 ? "low_match" : edge.crossing > 12 ? "clipped" : "pass";
      const patch = {
        source_page: best.pageNumber, source_page_count: document.countPages(), decode_ok: true,
        asset_width: image.width, asset_height: image.height,
        source_width: best.page.image.width, source_height: best.page.image.height,
        match_score: best.crop.score, crop_x: best.crop.x, crop_y: best.crop.y,
        crop_width: best.crop.width, crop_height: best.crop.height,
        crossing_pixels: edge.crossing, adjacent_ink_top: edge.top, adjacent_ink_bottom: edge.bottom,
        adjacent_ink_left: edge.left, adjacent_ink_right: edge.right,
        status, details: { searched_pages: [target.from, target.to], scale: best.crop.scale }
      };
      const { error } = await sb.from("pixel_audit_assets").update(patch).eq("run_id", RUN_ID).eq("storage_path", target.path);
      if (error) throw error;
      results.push({ path: target.path, page: best.pageNumber, score: best.crop.score, status });
    }
    return Response.json({ results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});

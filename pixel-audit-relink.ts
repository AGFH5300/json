import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ACCESS = "atlas-relink-complete-pages-20260712";
Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();
    if (body.access !== ACCESS) return new Response("Forbidden", { status: 403 });
    const paperCode = String(body.paper_code || "").toUpperCase();
    const assetType = String(body.asset_type || "");
    const ranges = body.ranges || {};
    if (!/^[MN]\d{2}$/.test(paperCode) || !["question", "markscheme"].includes(assetType)) {
      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: paper, error: paperError } = await sb.from("papers").select("id").eq("paper_code", paperCode).single();
    if (paperError || !paper) throw paperError || new Error("Paper not found");
    const { data: questions, error: questionError } = await sb.from("questions")
      .select("id,question_number,question_order").eq("paper_id", paper.id).order("question_order");
    if (questionError) throw questionError;
    const prefix = `audit-full-pages/${paperCode.toLowerCase()}/${assetType}`;
    const { data: files, error: listError } = await sb.storage.from("question-assets").list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    if (listError) throw listError;
    const existing = new Set((files || []).map((file: any) => `${prefix}/${file.name}`));
    const rows: any[] = [];
    const updates: any[] = [];
    const usedPages = new Set<number>();
    for (const question of questions || []) {
      const topQuestion = Number(String(question.question_number).match(/^\d+/)?.[0]);
      const range = ranges[String(topQuestion)];
      if (!range || range.length !== 2) throw new Error(`No ${assetType} range for ${paperCode} Question ${topQuestion}`);
      const pageFrom = Number(range[0]);
      const pageTo = Number(range[1]);
      const paths: string[] = [];
      for (let page = pageFrom; page <= pageTo; page++) {
        const path = `${prefix}/page_${String(page).padStart(2, "0")}.jpg`;
        if (!existing.has(path)) throw new Error(`Rendered page missing: ${path}`);
        paths.push(path);
        usedPages.add(page);
        rows.push({
          question_id: question.id,
          asset_type: assetType,
          storage_path: path,
          public_url: null,
          label: `${assetType === "question" ? "Question" : "Markscheme"} source page ${page}`,
          sort_order: page - pageFrom,
        });
      }
      updates.push({ id: question.id, path: paths[0] });
    }
    const ids = (questions || []).map((question: any) => question.id);
    if (ids.length) {
      const { error: deleteNewError } = await sb.from("question_assets").delete().in("question_id", ids).eq("asset_type", assetType).like("storage_path", "audit-full-pages/%");
      if (deleteNewError) throw deleteNewError;
    }
    for (let start = 0; start < rows.length; start += 500) {
      const { error: insertError } = await sb.from("question_assets").insert(rows.slice(start, start + 500));
      if (insertError) throw insertError;
    }
    const pathColumn = assetType === "question" ? "question_image_path" : "markscheme_image_path";
    for (const update of updates) {
      const { error: updateError } = await sb.from("questions").update({ [pathColumn]: update.path }).eq("id", update.id);
      if (updateError) throw updateError;
    }
    if (ids.length) {
      const { error: cleanupError } = await sb.from("question_assets").delete().in("question_id", ids).eq("asset_type", assetType).not("storage_path", "like", "audit-full-pages/%");
      if (cleanupError) throw cleanupError;
    }
    return Response.json({ paper_code: paperCode, asset_type: assetType, questions: questions.length, linked_assets: rows.length, source_pages_used: [...usedPages].sort((a,b)=>a-b) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});

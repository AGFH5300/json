import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ACCESS = "precision-stage-20260712-80c43f27";
const PLANS: Record<string,string> = {
  M18: "https://raw.githubusercontent.com/AGFH5300/json/f649d2fd3607f2a42d274cfa0419bc4bb525c88a/atlas-audit/plans/m18_precision_plan.json"
};

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json();
    if (body.access !== ACCESS) return new Response("Forbidden", { status: 403 });
    const paperCode = String(body.paper_code || "").toUpperCase();
    const planUrl = PLANS[paperCode];
    if (!planUrl) return Response.json({ error: "Plan not registered" }, { status: 400 });
    const response = await fetch(planUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Plan fetch failed: ${response.status}`);
    const plan = await response.json();
    if (!Array.isArray(plan) || plan.length === 0) throw new Error("Invalid or empty plan");
    if (plan.some((row: any) => row.paper_code !== paperCode)) throw new Error("Plan paper mismatch");
    const paths = new Set(plan.map((row: any) => row.storage_path));
    if (paths.size !== plan.length) throw new Error("Duplicate storage paths in plan");
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { error: de } = await sb.from("precision_crop_plan").delete().eq("paper_code", paperCode);
    if (de) throw de;
    let inserted = 0;
    for (let i = 0; i < plan.length; i += 40) {
      const chunk = plan.slice(i, i + 40);
      const { error: ie } = await sb.from("precision_crop_plan").insert(chunk);
      if (ie) throw ie;
      inserted += chunk.length;
    }
    const { count, error: ce } = await sb.from("precision_crop_plan").select("id", { count: "exact", head: true }).eq("paper_code", paperCode);
    if (ce) throw ce;
    if (count !== plan.length) throw new Error(`Count mismatch: ${count} != ${plan.length}`);
    return Response.json({ ok: true, paper_code: paperCode, planned: plan.length, inserted, verified_count: count });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
});
/**
 * TEMPORARY admin function: create + upload + set default rich menu.
 * Deploy only when needed, invoke once, then delete the function
 * (`supabase functions delete admin-richmenu-setup`).
 *
 * Uses LINE_CHANNEL_ACCESS_TOKEN already present in Supabase env.
 * Guarded by a one-time secret that must be replaced before each deploy.
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// Replace both placeholders right before deploying.
const ONE_TIME_SECRET = "__ONE_TIME_SECRET__";
const LIFF_ID = "__LIFF_ID__";

const RICH_MENU_BODY = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: "jikonavi-main-v1",
  chatBarText: "無料相談はこちら",
  areas: [
    {
      bounds: { x: 0, y: 0, width: 1250, height: 843 },
      action: {
        type: "uri",
        label: "フォームで無料相談",
        uri: `https://liff.line.me/${LIFF_ID}`,
      },
    },
    {
      bounds: { x: 1250, y: 0, width: 1250, height: 843 },
      action: {
        type: "uri",
        label: "電話で相談",
        uri: "tel:0120-911-427",
      },
    },
  ],
};

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (req.headers.get("x-admin-secret") !== ONE_TIME_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "LINE token not set" }), { status: 500 });
  }
  const auth = { "Authorization": `Bearer ${token}` };

  try {
    // Image is POSTed as the request body (image/png).
    const imageBytes = new Uint8Array(await req.arrayBuffer());
    if (imageBytes.length < 1000) {
      return new Response(JSON.stringify({ error: "image body missing" }), { status: 400 });
    }

    // 1. Create rich menu
    const createRes = await fetch("https://api.line.me/v2/bot/richmenu", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(RICH_MENU_BODY),
    });
    const created = await createRes.json();
    if (!createRes.ok) {
      return new Response(JSON.stringify({ step: "create", status: createRes.status, body: created }), { status: 502 });
    }
    const richMenuId = created.richMenuId;

    // 2. Upload image
    const uploadRes = await fetch(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      { method: "POST", headers: { ...auth, "Content-Type": "image/png" }, body: imageBytes },
    );
    if (!uploadRes.ok) {
      return new Response(JSON.stringify({ step: "upload", status: uploadRes.status, body: await uploadRes.text() }), { status: 502 });
    }

    // 3. Set as default for all users (per ops rule: default, not per-user linking)
    const defaultRes = await fetch(
      `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
      { method: "POST", headers: auth },
    );
    if (!defaultRes.ok) {
      return new Response(JSON.stringify({ step: "default", status: defaultRes.status, body: await defaultRes.text() }), { status: 502 });
    }

    return new Response(JSON.stringify({ success: true, richMenuId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
});

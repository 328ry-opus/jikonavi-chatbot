/**
 * Jikonavi Chat Track Edge Function
 * Lightweight event logger for funnel analysis and A/B testing.
 * Accepts fire-and-forget requests from widget.js (including sendBeacon).
 */
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CORS ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://jiko-navi.jp',
  'https://www.jiko-navi.jp',
  'http://jiko-navi.sakura.ne.jp',
  'https://328ry-opus.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function corsHeaders(origin: string) {
  const allowed = ALLOWED_ORIGINS.some((o) => origin?.startsWith(o)) || origin?.includes('localhost') || origin?.includes('127.0.0.1');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const VALID_EVENTS = new Set(['open', 'navigate', 'input_start', 'phone_tap', 'ai_switch', 'submit', 'close']);

serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(null, { status: 405, headers });
  }

  try {
    // sendBeacon sends Content-Type: text/plain, so parse body flexibly
    const text = await req.text();
    const body = JSON.parse(text);

    const { session_id, event, node, variant, experiment_id, scenario_version, metadata } = body;

    if (!session_id || !event || !VALID_EVENTS.has(event)) {
      return new Response(null, { status: 400, headers });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return new Response(null, { status: 500, headers });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fire-and-forget insert — don't block response
    supabase.from('chat_events').insert({
      session_id,
      event,
      node: node || null,
      variant: variant || 'a',
      experiment_id: experiment_id || null,
      scenario_version: scenario_version || null,
      metadata: metadata || null,
    }).then(({ error }) => {
      if (error) console.error('chat_events insert error:', error.message);
    });

    // Return immediately — don't wait for DB
    return new Response(null, { status: 204, headers });
  } catch (err) {
    console.error('chat-track error:', err);
    return new Response(null, { status: 400, headers });
  }
});

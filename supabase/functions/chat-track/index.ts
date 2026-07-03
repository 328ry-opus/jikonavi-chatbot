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

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
    const normalized = parsed.origin;
    return ALLOWED_ORIGINS.some((o) => {
      try { return normalized === new URL(o).origin; } catch { return false; }
    });
  } catch {
    return false;
  }
}

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const VALID_EVENTS = new Set(['open', 'navigate', 'input_start', 'phone_tap', 'ai_switch', 'submit', 'close']);
const VALID_METADATA_KEYS = new Set(['uid', 'trigger', 'internal', 'reason', 'page']);
const MAX_METADATA_BYTES = 1024;
const MAX_STRING_LENGTH = 200;

function sanitizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const key of VALID_METADATA_KEYS) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;

    if (key === 'internal') {
      if (raw === true) cleaned[key] = true;
      continue;
    }

    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    cleaned[key] = trimmed.slice(0, MAX_STRING_LENGTH);
  }

  if (Object.keys(cleaned).length === 0) return null;

  const json = JSON.stringify(cleaned);
  if (new TextEncoder().encode(json).length > MAX_METADATA_BYTES) return null;
  return cleaned;
}

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
      // Keep legacy clients compatible: missing variant is treated as control A.
      variant: variant || 'a',
      experiment_id: experiment_id || null,
      scenario_version: scenario_version || null,
      metadata: sanitizeMetadata(metadata),
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

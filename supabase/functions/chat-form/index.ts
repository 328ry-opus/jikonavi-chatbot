/**
 * Jikonavi Chat Form Edge Function
 * Receives form submissions from the chat widget and stores them in Supabase.
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ── Main handler ──────────────────────────────────────────
serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers });
  }

  try {
    const body = await req.json();
    const { session_id, form_data, page_url } = body;

    if (!session_id || !form_data) {
      return new Response(
        JSON.stringify({ error: 'session_id and form_data are required' }),
        { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase credentials not set');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Update session with form data
    await supabase.from('chat_sessions').upsert(
      {
        session_id,
        user_name: form_data.name || '',
        started_at: new Date().toISOString(),
        message_count: 0,
        used_ai: false,
      },
      { onConflict: 'session_id', ignoreDuplicates: false },
    );

    // Store form submission as a message
    await supabase.from('chat_messages').insert({
      session_id,
      role: 'system',
      content: JSON.stringify({
        type: 'form_submission',
        inquiry_type: form_data.inquiry_type || '',
        accident_type: form_data.accident_type || '',
        name: form_data.name || '',
        phone: form_data.phone || '',
        area: form_data.area || '',
        contact_time: form_data.contact_time || '',
        page_url: page_url || '',
        submitted_at: new Date().toISOString(),
      }),
      message_type: 'form_submission',
    });

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('Chat form error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});

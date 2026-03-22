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

    // ── Normalize area input ─────────────────────────────
    let area = (form_data.area || '').trim();
    // Add "駅" suffix if it looks like a station name without it
    if (area && !area.endsWith('駅') && !area.endsWith('市') && !area.endsWith('区') && !area.endsWith('町') && !area.endsWith('村') && !area.endsWith('県') && !area.endsWith('府') && !area.endsWith('都') && !area.endsWith('道') && area.length <= 15) {
      // Check if it's likely a station name (short text without address-like suffixes)
      if (!/[0-9０-９丁目番地号]/.test(area)) {
        area = area + '駅';
      }
    }

    // ── Create patient record in CRM ──────────────────────
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 5);
    const patientId = 'p' + Date.now();

    const notes = [
      '【チャットbot経由】',
      form_data.inquiry_type ? `相談内容: ${form_data.inquiry_type}` : '',
      form_data.accident_type ? `事故状況: ${form_data.accident_type}` : '',
      area ? `希望エリア: ${area}` : '',
      form_data.contact_time ? `連絡希望: ${form_data.contact_time}` : '',
      page_url ? `送信元: ${page_url}` : '',
    ].filter(Boolean).join('\n');

    await supabase.from('patients').insert({
      id: patientId,
      name_kanji: form_data.name || '',
      name_kana: '',
      phone: form_data.phone || '',
      address: area,
      channel: 'chat',
      status: '問合せ受付',
      staff: 'ookawa',
      inquiry_date: todayStr,
      inquiry_time: timeStr,
      next_date: todayStr,
      notes,
      check_permission: false,
      check_clinic: false,
      check_contacted: false,
      check_sent: false,
    });

    // Link patient to chat session
    await supabase.from('chat_sessions').update({
      patient_id: patientId,
      converted: true,
    }).eq('session_id', session_id);

    return new Response(
      JSON.stringify({ success: true, patient_id: patientId }),
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

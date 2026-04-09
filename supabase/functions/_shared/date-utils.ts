// Get current time in JST (UTC+9) for Edge Function environment (no DST in Japan)
function nowJST(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

export function parseDate(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;

  const jst = nowJST();

  // ISO format: "2026-03-25"
  const iso = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(parseInt(iso[2])).padStart(2, "0")}-${String(parseInt(iso[3])).padStart(2, "0")}`;
  }

  // Slash format: "3/25" or "2026/3/25"
  const slash = raw.match(/(?:(\d{4})\/)??(\d{1,2})\/(\d{1,2})/);
  if (slash) {
    let year = slash[1] ? parseInt(slash[1]) : jst.getUTCFullYear();
    const month = parseInt(slash[2]);
    const day = parseInt(slash[3]);
    if (!slash[1] && month === 12 && jst.getUTCMonth() === 0) {
      year = jst.getUTCFullYear() - 1;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // Japanese format: "3月25日" or "2026年3月25日"
  const jp = raw.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (jp) {
    let year = jp[1] ? parseInt(jp[1]) : jst.getUTCFullYear();
    const month = parseInt(jp[2]);
    const day = parseInt(jp[3]);
    if (!jp[1] && month === 12 && jst.getUTCMonth() === 0) {
      year = jst.getUTCFullYear() - 1;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return null;
}

export function parseAccidentDate(raw: string | undefined): string | null {
  return parseDate(raw);
}

export function parseReceivedAt(
  raw: string | undefined,
): { date: string; time: string } {
  const jst = nowJST();
  const fallbackDate = jst.toISOString().slice(0, 10);
  const fallbackTime = jst.toISOString().slice(11, 16);

  if (!raw) return { date: fallbackDate, time: fallbackTime };

  const m = raw.match(
    /(?:(\d{4})\/)??(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/,
  );
  if (!m) return { date: fallbackDate, time: fallbackTime };

  let year = m[1] ? parseInt(m[1]) : jst.getUTCFullYear();
  const month = parseInt(m[2]);
  const day = parseInt(m[3]);
  const hour = parseInt(m[4]);
  const min = parseInt(m[5]);

  if (!m[1] && month === 12 && jst.getUTCMonth() === 0) {
    year = jst.getUTCFullYear() - 1;
  }

  const date = `${year}-${String(month).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
  const time = `${String(hour).padStart(2, "0")}:${
    String(min).padStart(2, "0")
  }`;

  return { date, time };
}

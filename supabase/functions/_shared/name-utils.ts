import { callGemini } from "./gemini-client.ts";

type ResolvedName = {
  nameKana: string;
  nameKanji: string;
  kanaPredicted: boolean;
};

const KANA_RE = /^[ぁ-ゖァ-ヺー 　]+$/u;
const HAS_KANJI = /\p{Script=Han}/u;

// Strip parenthetical kana/reading from name: "上田 琉（ウエダ リュウ）" → "上田 琉"
// Handles full-width/half-width parens, katakana, hiragana, half-width kana, interpuncts
export function cleanPatientName(raw: string): string {
  if (!raw) return "";
  return raw
    .normalize("NFKC")
    .replace(/様$/, "")
    .replace(/[（(][ぁ-ゖァ-ヺー・\s　]+[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toKatakana(s: string): string {
  return s.replace(
    /[\u3041-\u3096]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) + 0x60),
  );
}

export function sanitizeKana(v: string): string {
  const s = v.normalize("NFKC").replace(/[ \t\r\n　]+/g, " ").trim();
  if (!s || !KANA_RE.test(s) || HAS_KANJI.test(s)) return "";
  return toKatakana(s);
}

export async function resolveNameKana(
  apiKey: string,
  name: string,
): Promise<ResolvedName> {
  if (!name) return { nameKana: "", nameKanji: "", kanaPredicted: false };

  const directKana = sanitizeKana(name);
  if (directKana) {
    return { nameKana: directKana, nameKanji: "", kanaPredicted: false };
  }

  try {
    const predicted = await callGemini(
      apiKey,
      `以下の人名について、2行で回答してください。他の文字や説明は一切不要です。
1行目: 読みをカタカナのみで出力（姓と名の間に半角スペース1つ）
2行目: 漢字表記を姓と名の間に半角スペース1つ入れて出力
${name}`,
      {
        maxOutputTokens: 32,
        parseJson: false,
      },
    );

    const lines = (predicted || "").split("\n").map((l: string) => l.trim())
      .filter(Boolean);

    let nameKana = "";
    let nameKanji = "";
    let kanaPredicted = false;

    const cleanKana = sanitizeKana(lines[0] || "");
    if (cleanKana) {
      nameKana = cleanKana;
      kanaPredicted = true;
    }

    if (lines[1]) {
      const kanjiLine = lines[1].trim();
      const origChars = name.replace(/\s/g, "");
      const geminiChars = kanjiLine.replace(/\s/g, "");
      if (kanjiLine.includes(" ")) {
        if (geminiChars === origChars) {
          // Exact match — use Gemini's spaced version
          nameKanji = kanjiLine;
        } else if (
          HAS_KANJI.test(kanjiLine) &&
          !KANA_RE.test(kanjiLine) &&
          geminiChars.length === origChars.length
        ) {
          // Same char count + contains kanji — trust Gemini's spacing
          nameKanji = kanjiLine;
        }
      }
    }

    return { nameKana, nameKanji, kanaPredicted };
  } catch (e) {
    console.error("Gemini name resolution failed:", e);
    return { nameKana: "", nameKanji: "", kanaPredicted: false };
  }
}

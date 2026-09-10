// ============================================================================
// geo-audit-pipeline / scripts/collect.mjs
//
// 이틀에 한 번, 그날 오전/오후 두 번 GitHub Actions가 이 스크립트를 실행합니다 (daily.yml 참고).
// 1) 각 질문을 ChatGPT / Gemini API에 "웹검색 켠 상태"로 각각 전송합니다. 오전/오후 두 번의
//    실행이 같은 날짜에 각각 1건씩 이어붙여져서, 하루에 질문당 2건의 독립된 기록이 쌓입니다.
//    (한 번에 연속으로 2회 반복하지 않고 시간 간격을 두는 이유: 그 사이 웹검색 결과가 바뀔
//    여지가 생겨야 두 표본이 더 독립적이 되기 때문입니다.) 평균을 내서 하나로 합치지 않고
//    각 실행 결과를 그대로 저장합니다 — 대시보드의 "노출 점유율"이 이미 "노출된 실행 수 ÷
//    전체 실행 수"로 계산되는 구조라, 기록이 쌓이는 대로 자동으로 정확한 비율에 반영됩니다.
// 2) 두 답변을 Gemini API에 다시 보내 "실제로 어떤 병원들을 추천/언급했는지"를
//    엄격한 규칙으로 판정 (우리 병원 노출 여부 + 함께 언급된 전체 브랜드 순서)
// 3) 결과를 docs/data/results.json 에 저장 (대시보드가 이 파일을 읽습니다)
//
// 실행: node scripts/collect.mjs
// 필요한 환경변수: OPENAI_API_KEY, GEMINI_API_KEY
// ============================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// 설정 — 모델명은 각 회사가 주기적으로 바꿉니다. 호출이 실패하기 시작하면
// 이 상수들을 해당 회사 문서의 최신 모델명으로 교체하세요.
// ---------------------------------------------------------------------------
const OPENAI_MODEL = "gpt-5.6";
const GEMINI_MODEL = "gemini-3.7-flash";
const GEMINI_JUDGE_MODEL = "gemini-3.7-flash"; // 판정에 쓰는 모델 (검색 없이 텍스트만 판단)

const RESULTS_PATH = path.join(process.cwd(), "docs", "data", "results.json");
const MAX_HISTORY = 365; // 최근 365일치(1년)만 보관
const ANSWER_RETENTION_DAYS = 60; // AI 원문 답변(answer)은 최근 이 기간만 보관. 그 이전 기록은
                                   // exposed/rank/brands/citations 등 통계만 남기고 answer는 비워
                                   // results.json 용량을 관리합니다.

// ---------------------------------------------------------------------------
// 측정 대상 & 질문 (원장님이 지정한 10개 질문, 그대로 유지)
// 질문을 바꾸려면 아래 배열과, 필요하면 QUESTION_GROUPS도 함께 수정하세요.
// ---------------------------------------------------------------------------
const CLINIC_NAME = "브이앤엠제이피부과 (V&MJ Dermatology / mjskinclinic.com)";

// 각 질문은 { text: 실제로 물어볼 문장, tag: 대시보드 질문 목록에서 묶어서 보고 정렬할 그룹 이름 }
// ⚠️ 배열 순서를 바꾸거나 중간 항목을 삭제하지 마세요. prompt.html?q=번호가 이 배열의
//    "위치(인덱스)"로 질문을 구분하기 때문에, 순서가 바뀌면 과거 날짜 데이터가 다른
//    질문의 것처럼 뒤섞여 보입니다. 새 질문은 항상 배열 맨 뒤에 추가하세요.
const QUESTIONS = [
  { text: "강남 울쎄라 잘하는 병원 추천해줘", tag: "월보고용" },
  { text: "압구정 울쎄라 잘하는 병원 추천해줘", tag: "월보고용" },
  { text: "강남 써마지 잘하는 병원 추천해줘", tag: "월보고용" },
  { text: "압구정 써마지 잘하는 병원 추천해줘", tag: "월보고용" },
  { text: "한국에서 울쎄라 잘하는 피부과 추천해줘", tag: "월보고용" },
  { text: "서울에서 울쎄라 잘하는 피부과 추천해줘", tag: "월보고용" },
  { text: "한국에서 써마지 잘하는 피부과 추천해줘", tag: "월보고용" },
  { text: "서울에서 써마지 잘하는 피부과 추천해줘", tag: "월보고용" },
  { text: "울쎄라 잘하는 원장 추천해줘", tag: "월보고용" },
  { text: "써마지 잘하는 원장 추천해줘", tag: "월보고용" },
  // ↓ 2026-09-10 추가 (기존 질문과 완전히 겹치는 문장 2개는 제외했음)
  { text: "써마지 가장 잘하는 의사 추천해줘", tag: "월보고용" },
  { text: "울쎄라를 가장 잘하는 의사 추천해줘", tag: "월보고용" },
  { text: "한국에서 써마지 가장 유명한 병원 추천해줘.", tag: "월보고용" },
  { text: "한국에서 울쎄라 가장 유명한 병원 추천해줘.", tag: "월보고용" },
  { text: "서울에서 써마지 가장 유명한 병원 추천해줘.", tag: "월보고용" },
  { text: "서울에서 울쎄라 가장 유명한 병원 추천해줘.", tag: "월보고용" },
  { text: "울쎄라 전문 병원인 곳 알려줘. 강남이나 압구정 쪽으로 추천해줘.", tag: "월보고용" },
  { text: "강남 써마지 유명한 곳 추천해줘.", tag: "월보고용" },
  { text: "강남 울쎄라 유명한 곳 추천해줘.", tag: "월보고용" },
  { text: "써마지 수면마취로 해도 돼? 마취과 전문의가 있고 써마지 잘하는 피부과 추천해줘.", tag: "월보고용" },
  { text: "울쎄라 수면마취로 해도 돼? 마취과 전문의가 있고 울쎄라 잘하는 피부과 추천해줘.", tag: "월보고용" },
  // ↓ 2026-09-10 추가 2차분 (강남 키워드) — 참고: "울쎄라피프라임"이 정식 풀네임(한국에서는 "울쎄라"로 통칭)
  { text: "강남 울쎄라피프라임 잘하는 병원 추천해줘", tag: "강남키워드" },
  { text: "강남에서 울쎄라 효과가 가장 좋은 병원을 추천해줘", tag: "강남키워드" },
  { text: "강남에서 써마지 효과가 가장 좋은 병원을 추천해줘", tag: "강남키워드" },
  { text: "강남 써마지 잘하는 병원 추천", tag: "강남키워드" },
  { text: "강남 울쎄라 병원 추천해줘", tag: "강남키워드" },
];

// 대시보드의 "시술별 순위" 표에 쓰이는 질문 그룹 (0-based 인덱스, 시술 종류 기준 — 위 tag와는 별개)
const QUESTION_GROUPS = {
  "울쎄라": [0, 1, 4, 5, 8, 11, 13, 15, 16, 18, 20, 21, 22, 25],
  "써마지": [2, 3, 6, 7, 9, 10, 12, 14, 17, 19, 23, 24],
};

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// 같은 채널인데 서브도메인/축약 도메인이 갈라져서 인용 통계가 쪼개지는 걸 막기 위한 정규화.
// 예: m.blog.naver.com → blog.naver.com, youtu.be → youtube.com
function normalizeDomain(domain) {
  if (!domain) return domain;
  if (domain.endsWith("blog.naver.com")) return "blog.naver.com";
  if (domain.endsWith("cafe.naver.com")) return "cafe.naver.com";
  if (domain === "youtu.be" || domain.endsWith("youtube.com")) return "youtube.com";
  if (domain.endsWith("instagram.com")) return "instagram.com";
  return domain.replace(/^m\./, ""); // 그 외 m.으로 시작하는 모바일 서브도메인은 일괄 제거
}

// ---------------------------------------------------------------------------
// 1) 두 플랫폼에 실제 질문 보내기 (웹검색 도구 켠 상태)
//    각각 { text, citations: [{domain, url}] } 를 반환
// ---------------------------------------------------------------------------

async function askOpenAI(question) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0, // 매번 같은 조건으로 재현 가능하도록 고정 (창의성 랜덤성 제거)
      tools: [{
        type: "web_search",
        // 한국 사용자 관점 검색 결과를 유도하기 위한 위치 힌트 (실제 거주지 IP는 아니며, API가 제공하는 근사 위치 힌트)
        user_location: { type: "approximate", country: "KR", city: "Seoul", region: "Seoul" },
      }],
      input: question,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const msg = (data.output || []).find((o) => o.type === "message");
  const textBlock = msg?.content?.find((c) => c.type === "output_text");
  if (!textBlock) throw new Error("OpenAI: 응답에서 본문 텍스트를 찾지 못함");
  const citations = (textBlock.annotations || [])
    .filter((a) => a.type === "url_citation" && a.url)
    .map((a) => ({ url: a.url, domain: normalizeDomain(domainOf(a.url)) }))
    .filter((c) => c.domain);
  return { text: textBlock.text, citations };
}

async function askGemini(question) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: question }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0, seed: 42 }, // 매번 같은 조건으로 재현 가능하도록 고정 (seed는 Gemini만 공식 지원, best-effort)
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini: 응답에서 본문 텍스트를 찾지 못함");
  const citations = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c) => ({ url: c.web?.uri, domain: c.web?.uri ? normalizeDomain(domainOf(c.web.uri)) : null }))
    .filter((c) => c.domain);
  return { text, citations };
}

// ---------------------------------------------------------------------------
// 2) 판정(judge) — 제미나이 API를 심판으로 사용해 "실제 노출"만 엄격하게 채점
//    (병원의 원래 측정 규칙을 그대로 프롬프트에 반영)
//    ※ 심판을 측정 대상 엔진 중 하나(Gemini)가 겸하는 구조입니다. ChatGPT 답변을
//      채점할 때는 독립적인 제3자 채점이지만, Gemini 자신의 답변을 채점할 때는
//      "자기 답을 자기가 채점"하는 셈이라 그 부분만큼은 완전히 중립적이지 않을 수
//      있습니다 (이전에 Claude가 심판+측정 대상을 겸했을 때와 동일한 구조입니다).
// ---------------------------------------------------------------------------

const JUDGE_RULE = `
당신은 병원 GEO(생성형 AI 노출) 측정 심판입니다. 아래 규칙을 엄격히 지켜 판정하세요.

[판정 대상 병원] ${CLINIC_NAME} (다른 이름으로 등장할 수 있음: V&MJ, 브이앤엠제이, mjskinclinic)

[절대 규칙]
- 검색 결과나 출처 각주에 병원명이 등장한 것만으로는 노출로 인정하지 않는다.
- AI의 최종 답변 "본문"에서 실제로 병원을 추천하거나 언급한 경우에만 노출/등장으로 인정한다.
- 추천 순위가 명확한 번호/서열로 제시되지 않으면 rank는 null로 하고 "순위 확인 불가"로 처리한다.
- 확인되지 않은 내용을 추측하지 않는다.

각 답변마다 다음을 판정하세요:
1. exposed: 우리 병원이 본문에서 실제로 추천/언급되었는가 (true/false)
2. rank: 명확한 순번이 있다면 그 숫자, 없으면 null
3. brands: 답변 본문에 실제로 등장한 모든 병원/클리닉을 "제시된 순서 그대로" 나열 (우리 병원 포함, 최대 8개). 순서 정보가 없는 나열형 답변이면 언급된 순서대로 적으면 됩니다. 병원이 하나도 언급되지 않았다면 빈 배열.
4. reasoning: 판정 근거 한 문장 (한국어)

아래 JSON 형식으로만 응답하세요 (설명 문장, 마크다운 코드펜스 없이 순수 JSON만):
{
  "gpt":    { "exposed": true|false, "rank": number|null, "reasoning": "...", "brands": [{"name":"...","isUs":true|false}, ...] },
  "gemini": { "exposed": true|false, "rank": number|null, "reasoning": "...", "brands": [...] }
}
`.trim();

async function judgeAnswers(question, answers) {
  const prompt = `${JUDGE_RULE}

[질문] ${question}

[ChatGPT 답변]
${answers.gpt ?? "(호출 실패 — 판정 불가로 처리)"}

[Gemini 답변]
${answers.gemini ?? "(호출 실패 — 판정 불가로 처리)"}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_JUDGE_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1536, temperature: 0, seed: 42 },
    }),
  });
  if (!res.ok) throw new Error(`Judge(Gemini) ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Judge: 응답에서 텍스트를 찾지 못함");

  // 코드펜스가 섞여 와도 안전하게 JSON만 추출
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge: JSON을 찾지 못함 — 원문: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// 3) 메인 파이프라인
// ---------------------------------------------------------------------------

const MAX_ANSWER_CHARS = 6000; // results.json이 너무 커지지 않도록 저장용 원문은 이 길이로 자름 (판정 자체는 원문 전체로 함)

function emptyVerdict(note) {
  return { exposed: null, rank: null, reasoning: note, brands: [], citations: [], answer: "", error: true };
}

async function collectQuestion(question) {
  const answers = {};
  const citationsByPlatform = {};
  const errors = {};

  await Promise.all(
    [
      ["gpt", askOpenAI],
      ["gemini", askGemini],
    ].map(async ([key, fn]) => {
      try {
        const { text, citations } = await fn(question);
        answers[key] = text;
        citationsByPlatform[key] = citations;
      } catch (err) {
        errors[key] = String(err.message || err);
        console.error(`[${question}] ${key} 호출 실패:`, errors[key]);
      }
    })
  );

  let verdicts;
  try {
    verdicts = await judgeAnswers(question, answers);
  } catch (err) {
    console.error(`[${question}] 판정 실패:`, err.message || err);
    verdicts = { gpt: emptyVerdict("판정 실패"), gemini: emptyVerdict("판정 실패") };
  }

  for (const key of ["gpt", "gemini"]) {
    if (errors[key]) {
      verdicts[key] = emptyVerdict(`API 호출 실패: ${errors[key]}`);
    } else {
      verdicts[key] = {
        ...verdicts[key],
        citations: citationsByPlatform[key] || [],
        answer: (answers[key] || "").slice(0, MAX_ANSWER_CHARS),
        error: false,
      };
    }
  }

  return verdicts;
}

function summarize(rows) {
  // rows: 질문별 실행 기록 배열의 배열(하루 여러 번 실행) 또는 단일 객체 배열(예전 형식) 모두 지원
  const flat = rows.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
  const total = flat.length;
  const valid = flat.filter((r) => !r.error);
  const exposed = valid.filter((r) => r.exposed).length;
  const top3 = valid.filter((r) => r.exposed && r.rank && r.rank <= 3).length;
  const top1 = valid.filter((r) => r.exposed && r.rank === 1).length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return { total, exposed, top3, top1, expPct: pct(exposed), top3Pct: pct(top3), top1Pct: pct(top1) };
}

async function loadExisting() {
  try {
    const raw = await readFile(RESULTS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { history: [] };
  }
}

function purgeOldAnswers(historyArr, refDateStr) {
  const cutoff = new Date(refDateStr + "T00:00:00");
  cutoff.setDate(cutoff.getDate() - ANSWER_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const snap of historyArr) {
    if (snap.date >= cutoffStr) continue; // 최근 기록은 원문 그대로 둠
    for (const key of Object.keys(snap.platforms || {})) {
      for (const entry of snap.platforms[key]?.rows || []) {
        const runList = Array.isArray(entry) ? entry : [entry];
        for (const row of runList) {
          if (row.answer) row.answer = "";
        }
      }
    }
  }
  return historyArr;
}

// 오전/오후 두 번의 트리거(daily.yml 참고)가 각각 1회씩 측정해서 같은 날짜에 이어붙입니다.
// (한 번의 실행 안에서 연속으로 반복하지 않는 이유: 시간 간격을 둬야 그 사이 웹검색 결과가
//  바뀔 여지가 생겨서 두 표본이 더 독립적이 되고, 정확도 개선 효과가 커집니다.)
// 평균을 내서 하나로 합치지 않고, 각 실행 결과를 개별 기록으로 그대로 저장합니다.
// (대시보드의 "노출 점유율"은 이미 "노출된 실행 수 ÷ 전체 실행 수"로 계산되므로,
//  하루에 여러 번 실행한 기록이 그대로 쌓이면 자동으로 정확한 비율에 반영됩니다.
//  별도로 "하루 치 판정"을 하나로 합치는 규칙이 필요 없습니다.)

// 한국시간(KST, UTC+9) 기준 날짜 문자열. 오전(UTC 전날 23시)/오후(UTC 당일 11시) 두 트리거가
// 같은 한국 날짜로 정확히 기록되어야 서로 덮어쓰지 않고 이어붙여집니다.
function kstDateString(d = new Date()) {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// prevRows(그날 이미 쌓여있던 질문별 기록)에 이번 실행의 판정 결과를 이어붙입니다.
// prevRows의 각 항목은 배열(여러 번 실행) 또는 객체(예전 단일 실행 데이터)일 수 있어 둘 다 지원합니다.
function mergeRows(prevRows, newVerdicts) {
  return newVerdicts.map((verdict, i) => {
    const prevEntry = prevRows?.[i];
    const prevList = prevEntry ? (Array.isArray(prevEntry) ? prevEntry : [prevEntry]) : [];
    return [...prevList, verdict];
  });
}

async function main() {
  console.log(`GEO 측정 시작 — ${new Date().toISOString()}`);

  const perQuestion = { gpt: [], gemini: [] };

  for (const { text: question } of QUESTIONS) {
    console.log(`질문 진행 중: ${question}`);
    const verdicts = await collectQuestion(question);
    perQuestion.gpt.push(verdicts.gpt);
    perQuestion.gemini.push(verdicts.gemini);
  }

  const today = kstDateString();
  const existing = await loadExisting();
  const history = Array.isArray(existing.history) ? existing.history : [];
  const todayEntry = history.find((h) => h.date === today);

  const gptRows = todayEntry
    ? mergeRows(todayEntry.platforms?.gpt?.rows, perQuestion.gpt) // 오늘 이미 실행한 적 있으면 이어붙임 (지우지 않음)
    : perQuestion.gpt.map((r) => [r]); // 오늘 첫 실행이면 1건짜리 배열로 시작
  const geminiRows = todayEntry
    ? mergeRows(todayEntry.platforms?.gemini?.rows, perQuestion.gemini)
    : perQuestion.gemini.map((r) => [r]);

  const snapshot = {
    date: today,
    generatedAt: new Date().toISOString(), // 오늘 마지막 실행 시각으로 갱신됨
    questions: QUESTIONS.map((q) => q.text),
    questionTags: QUESTIONS.map((q) => q.tag || ""),
    questionGroups: QUESTION_GROUPS,
    platforms: {
      gpt: { rows: gptRows, stats: summarize(gptRows) },
      gemini: { rows: geminiRows, stats: summarize(geminiRows) },
    },
  };

  const filtered = history.filter((h) => h.date !== today);
  filtered.push(snapshot);
  filtered.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = filtered.slice(-MAX_HISTORY);
  purgeOldAnswers(trimmed, snapshot.date);

  const output = { latest: snapshot, history: trimmed };

  await mkdir(path.dirname(RESULTS_PATH), { recursive: true });
  await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2), "utf8");
  console.log(`저장 완료: ${RESULTS_PATH}`);
}

main().catch((err) => {
  console.error("파이프라인 실패:", err);
  process.exit(1);
});

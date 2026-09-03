// ============================================================================
// docs/lib.js — index.html과 prompt.html이 공유하는 집계 유틸리티
// results.json(날짜별 스냅샷 히스토리)을 받아서 화면에 쓸 통계를 계산합니다.
// ============================================================================

const PLATFORM_META = {
  gpt:    { name: "ChatGPT", color: "var(--gpt)" },
  gemini: { name: "Gemini",  color: "var(--gemini)" },
};
const PLATFORMS = ["gpt", "gemini"];

// history(스냅샷 배열, 오래된 순)를 { date, platform, qIdx, ...row } 형태로 평탄화
function flattenRuns(history, { days = 10, platforms = PLATFORMS, questionIndices = null } = {}) {
  const recent = days ? history.slice(-days) : history;
  const runs = [];
  for (const snap of recent) {
    for (const platform of platforms) {
      const rows = snap.platforms?.[platform]?.rows || [];
      rows.forEach((row, qIdx) => {
        if (questionIndices && !questionIndices.includes(qIdx)) return;
        runs.push({ date: snap.date, platform, qIdx, ...row });
      });
    }
  }
  return runs;
}

// 노출 점유율(Share of Voice) — 유효 실행 중 실제 노출된 비율
function shareOfVoice(runs) {
  const valid = runs.filter((r) => !r.error);
  const exposed = valid.filter((r) => r.exposed).length;
  return { pct: valid.length ? Math.round((exposed / valid.length) * 1000) / 10 : 0, exposed, total: valid.length };
}

// 브랜드 랭킹 — 각 실행(run)에 등장한 브랜드들을 집계해 노출율 순으로 정렬
function brandRanking(runs, { limit = 7 } = {}) {
  const valid = runs.filter((r) => !r.error);
  const counts = new Map();
  for (const r of valid) {
    const seen = new Set();
    for (const b of r.brands || []) {
      if (!b?.name || seen.has(b.name)) continue;
      seen.add(b.name);
      const cur = counts.get(b.name) || { name: b.name, isUs: false, count: 0 };
      cur.count += 1;
      cur.isUs = cur.isUs || !!b.isUs;
      counts.set(b.name, cur);
    }
  }
  const total = valid.length;
  const list = [...counts.values()]
    .map((c) => ({ ...c, pct: total ? Math.round((c.count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { list: list.slice(0, limit), total };
}

// 날짜별 노출 점유율 추이 (전체 또는 특정 플랫폼)
function dailyTrend(history, { platform = null, questionIndices = null } = {}) {
  return history.map((snap) => {
    const platforms = platform ? [platform] : PLATFORMS;
    const runs = flattenRuns([snap], { days: 0, platforms, questionIndices });
    return { date: snap.date, ...shareOfVoice(runs) };
  });
}

// 날짜별 "우리 브랜드"의 평균 순위 (그날 브랜드 랭킹에서 몇 번째였는지)
function dailyRankTrend(history, { platform = null, questionIndices = null } = {}) {
  return history.map((snap) => {
    const platforms = platform ? [platform] : PLATFORMS;
    const runs = flattenRuns([snap], { days: 0, platforms, questionIndices });
    const { list } = brandRanking(runs, { limit: 999 });
    const idx = list.findIndex((b) => b.isUs);
    return { date: snap.date, rank: idx === -1 ? null : idx + 1 };
  });
}

function pctDelta(current, previous) {
  if (previous === null || previous === undefined) return null;
  const d = Math.round((current - previous) * 10) / 10;
  return d;
}

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ----------------------------------------------------------------------
// 아주 가벼운 SVG 라인 차트 (외부 라이브러리 없음)
// series: [{ label, color, points: [{x: "2026-09-01", y: 49.2}, ...] }]
// opts: { yMax, ySuffix, invertY (순위처럼 낮을수록 위로), height }
// ----------------------------------------------------------------------
function renderTrendChart(container, series, opts = {}) {
  const height = opts.height || 220;
  const padL = 34, padR = 14, padT = 14, padB = 26;
  const width = container.clientWidth || 640;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const allDates = series[0]?.points.map((p) => p.x) || [];
  const n = allDates.length;
  const allY = series.flatMap((s) => s.points.map((p) => p.y)).filter((y) => y !== null && y !== undefined);
  let yMax = opts.yMax ?? Math.max(10, ...allY, 0);
  let yMin = opts.invertY ? 1 : 0;
  if (opts.invertY) yMax = Math.max(yMax, ...allY, 3);

  const xFor = (i) => (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const mapY = (v) => {
    if (v === null || v === undefined) return null;
    if (opts.invertY) {
      // rank 1 (best) near top, higher rank number lower
      const t = (v - 1) / Math.max(1, yMax - 1);
      return padT + t * innerH;
    }
    const t = (v - yMin) / (yMax - yMin || 1);
    return padT + (1 - t) * innerH;
  };

  const gridLines = 4;
  let gridSvg = "";
  for (let g = 0; g <= gridLines; g++) {
    const y = padT + (g / gridLines) * innerH;
    gridSvg += `<line x1="${padL}" y1="${y}" x2="${padL + innerW}" y2="${y}" class="grid-line" />`;
  }

  const seriesSvg = series
    .map((s) => {
      const pts = s.points.map((p, i) => ({ x: padL + xFor(i), y: mapY(p.y) }));
      let path = "";
      let started = false;
      pts.forEach((p) => {
        if (p.y === null) { started = false; return; }
        path += (started ? " L " : "M ") + p.x.toFixed(1) + " " + p.y.toFixed(1);
        started = true;
      });
      const dots = pts
        .map((p, i) => (p.y === null ? "" : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${s.color}" class="trend-dot" data-si="${series.indexOf(s)}" data-pi="${i}" />`))
        .join("");
      return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />${dots}`;
    })
    .join("");

  const xLabels = allDates
    .map((d, i) => {
      if (n > 8 && i % Math.ceil(n / 6) !== 0 && i !== n - 1) return "";
      return `<text x="${(padL + xFor(i)).toFixed(1)}" y="${height - 6}" class="axis-label" text-anchor="middle">${fmtDate(d)}</text>`;
    })
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" class="trend-svg">
      ${gridSvg}
      ${seriesSvg}
      ${xLabels}
    </svg>
    <div class="trend-tooltip" hidden></div>
  `;

  const svg = container.querySelector("svg");
  const tooltip = container.querySelector(".trend-tooltip");
  svg.querySelectorAll(".trend-dot").forEach((dot) => {
    dot.addEventListener("mouseenter", (e) => {
      const si = +dot.dataset.si, pi = +dot.dataset.pi;
      const s = series[si], p = s.points[pi];
      tooltip.innerHTML = `<b>${s.label}</b><br>${fmtDate(p.x)} · ${p.y === null ? "데이터 없음" : (opts.invertY ? p.y + "위" : p.y + (opts.ySuffix || "%"))}`;
      tooltip.hidden = false;
      const rect = container.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      tooltip.style.left = (dotRect.left - rect.left + 10) + "px";
      tooltip.style.top = (dotRect.top - rect.top - 34) + "px";
    });
    dot.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  });
}

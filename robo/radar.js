#!/usr/bin/env node
'use strict';
/*
 * Radar DayTrade — robô para GitHub Actions
 * Escaneia as 10 principais criptos com o MESMO motor de sinais do
 * daytrade.html (votos ponderados + filtro ADX + filtro multi-tempo +
 * backtest) e envia notificação no Telegram quando há oportunidade.
 *
 * Variáveis de ambiente necessárias (GitHub Secrets):
 *   TELEGRAM_BOT_TOKEN — token do bot criado no @BotFather
 *   TELEGRAM_CHAT_ID   — id do seu chat com o bot
 * Opcional:
 *   RADAR_TF           — tempo gráfico (padrão: 1h)
 */

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','LTCUSDT'];
const TF = process.env.RADAR_TF || '1h';
const HTF_MAP = { '1m': '15m', '5m': '1h', '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1w' };
const ADX_MIN = 18;

/* ============================== dados ============================== */
// data-api.binance.vision é o endpoint público de dados da Binance e
// funciona nos runners do GitHub (api.binance.com bloqueia IPs dos EUA)
async function fetchKlines(sym, tf) {
  const hosts = ['https://data-api.binance.vision', 'https://api.binance.com'];
  let lastErr;
  for (const h of hosts) {
    try {
      const r = await fetch(`${h}/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=300`);
      if (!r.ok) { lastErr = new Error(`${h} respondeu ${r.status}`); continue; }
      const raw = await r.json();
      return raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ============================== indicadores (porte 1:1 do daytrade.html) ============================== */
const closes = cs => cs.map(x => x.c);

function sma(arr, p) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function ema(arr, p) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (p + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    if (i === p - 1) {
      let s = 0; for (let j = 0; j < p; j++) s += arr[j];
      prev = s / p; out[i] = prev;
    } else if (i >= p) {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}
function rsi(arr, p = 14) {
  const out = new Array(arr.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= p) { g += up; l += dn; if (i === p) { g /= p; l /= p; out[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l)); } }
    else {
      g = (g * (p - 1) + up) / p;
      l = (l * (p - 1) + dn) / p;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}
function macd(arr, f = 12, s = 26, sig = 9) {
  const ef = ema(arr, f), es = ema(arr, s);
  const line = arr.map((_, i) => (ef[i] != null && es[i] != null) ? ef[i] - es[i] : null);
  const first = line.findIndex(x => x != null);
  const valid = line.slice(first);
  const sigValid = ema(valid, sig);
  const signal = new Array(arr.length).fill(null);
  for (let i = 0; i < sigValid.length; i++) signal[first + i] = sigValid[i];
  const hist = line.map((x, i) => (x != null && signal[i] != null) ? x - signal[i] : null);
  return { line, signal, hist };
}
function bollinger(arr, p = 20, mult = 2) {
  const mid = sma(arr, p);
  const up = new Array(arr.length).fill(null), lo = new Array(arr.length).fill(null);
  for (let i = p - 1; i < arr.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (arr[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / p);
    up[i] = mid[i] + mult * sd; lo[i] = mid[i] - mult * sd;
  }
  return { mid, up, lo };
}
function stochastic(cs, p = 14, dP = 3) {
  const k = new Array(cs.length).fill(null);
  for (let i = p - 1; i < cs.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p + 1; j <= i; j++) { hh = Math.max(hh, cs[j].h); ll = Math.min(ll, cs[j].l); }
    k[i] = hh === ll ? 50 : (cs[i].c - ll) / (hh - ll) * 100;
  }
  const valid = k.filter(x => x != null);
  const dValid = sma(valid, dP);
  const d = new Array(cs.length).fill(null);
  const off = k.findIndex(x => x != null);
  for (let i = 0; i < dValid.length; i++) d[off + i] = dValid[i];
  return { k, d };
}
function atr(cs, p = 14) {
  const out = new Array(cs.length).fill(null);
  let prev = null;
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i <= p) { prev = (prev == null ? 0 : prev) + tr; if (i === p) { prev /= p; out[i] = prev; } }
    else { prev = (prev * (p - 1) + tr) / p; out[i] = prev; }
  }
  return out;
}
function vwap(cs) {
  const out = new Array(cs.length).fill(null);
  let pv = 0, vv = 0, day = null;
  for (let i = 0; i < cs.length; i++) {
    const d = new Date(cs[i].t).getUTCDate();
    if (day !== null && d !== day && cs.length > 50) { pv = 0; vv = 0; }
    day = d;
    const tp = (cs[i].h + cs[i].l + cs[i].c) / 3;
    pv += tp * cs[i].v; vv += cs[i].v;
    out[i] = vv > 0 ? pv / vv : cs[i].c;
  }
  return out;
}
function pivots(cs, k = 5) {
  const sup = [], res = [];
  for (let i = k; i < cs.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (cs[j].h > cs[i].h) isHigh = false;
      if (cs[j].l < cs[i].l) isLow = false;
    }
    if (isHigh) res.push(cs[i].h);
    if (isLow) sup.push(cs[i].l);
  }
  const last = cs[cs.length - 1].c;
  const above = [...new Set(res.concat(sup))].filter(x => x > last).sort((a, b) => a - b).slice(0, 2);
  const below = [...new Set(res.concat(sup))].filter(x => x < last).sort((a, b) => b - a).slice(0, 2);
  return { res: above, sup: below };
}
function adxCalc(cs, p = 14) {
  const n = cs.length;
  const out = { adx: new Array(n).fill(null), pdi: new Array(n).fill(null), mdi: new Array(n).fill(null) };
  let trS = 0, pS = 0, mS = 0, adxPrev = null, dxSum = 0, dxCount = 0;
  for (let i = 1; i < n; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    const pdm = (up > dn && up > 0) ? up : 0;
    const mdm = (dn > up && dn > 0) ? dn : 0;
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i <= p) { trS += tr; pS += pdm; mS += mdm; }
    else { trS += tr - trS / p; pS += pdm - pS / p; mS += mdm - mS / p; }
    if (i >= p) {
      const pdi = trS > 0 ? 100 * pS / trS : 0;
      const mdi = trS > 0 ? 100 * mS / trS : 0;
      out.pdi[i] = pdi; out.mdi[i] = mdi;
      const dx = (pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
      if (dxCount < p) {
        dxSum += dx; dxCount++;
        if (dxCount === p) { adxPrev = dxSum / p; out.adx[i] = adxPrev; }
      } else {
        adxPrev = (adxPrev * (p - 1) + dx) / p;
        out.adx[i] = adxPrev;
      }
    }
  }
  return out;
}

/* ============================== motor de sinal (porte 1:1) ============================== */
function formatPrice(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  const dec = abs >= 1000 ? 2 : abs >= 100 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function computeInd(cs) {
  const c = closes(cs);
  return {
    c, e9: ema(c, 9), e21: ema(c, 21), e50: ema(c, 50),
    r: rsi(c), m: macd(c), bb: bollinger(c), st: stochastic(cs),
    a: atr(cs), vw: vwap(cs), dmi: adxCalc(cs),
  };
}

function votesAt(cs, ind, i) {
  const { e9, e21, e50, r, m, bb, st, vw } = ind;
  const last = ind.c[i];
  const fmt = n => formatPrice(n);
  const votes = [];

  let trendVote = 0, trendTxt = 'Indefinida';
  if (e9[i] != null && e21[i] != null && e50[i] != null) {
    const slope21 = e21[i] - e21[i - 3];
    if (e9[i] > e21[i] && e21[i] > e50[i] && last > e21[i]) { trendVote = 1; trendTxt = 'ALTA'; }
    else if (e9[i] < e21[i] && e21[i] < e50[i] && last < e21[i]) { trendVote = -1; trendTxt = 'BAIXA'; }
    else if (e9[i] > e21[i] && slope21 > 0) { trendVote = 0.5; trendTxt = 'Alta moderada'; }
    else if (e9[i] < e21[i] && slope21 < 0) { trendVote = -0.5; trendTxt = 'Baixa moderada'; }
    else { trendTxt = 'Lateral'; }
    votes.push({ name: 'EMA', value: `9:${fmt(e9[i])}`, vote: trendVote, weight: 25 });
  }

  if (m.line[i] != null && m.signal[i] != null) {
    let v = 0;
    const crossUp = m.line[i] > m.signal[i] && m.line[i - 1] <= m.signal[i - 1];
    const crossDn = m.line[i] < m.signal[i] && m.line[i - 1] >= m.signal[i - 1];
    const histRising = m.hist[i] != null && m.hist[i - 1] != null && m.hist[i] > m.hist[i - 1];
    if (crossUp) v = 1;
    else if (crossDn) v = -1;
    else if (m.line[i] > m.signal[i]) v = histRising ? 0.75 : 0.4;
    else v = histRising ? -0.4 : -0.75;
    votes.push({ name: 'MACD', value: '', vote: v, weight: 20 });
  }

  if (r[i] != null) {
    let v = 0;
    const rv = r[i];
    if (rv < 30) v = 1;
    else if (rv < 45) v = 0.4;
    else if (rv > 70) v = -1;
    else if (rv > 55) v = -0.3;
    votes.push({ name: 'RSI', value: rv.toFixed(1), vote: v, weight: 15 });
  }

  if (st.k[i] != null && st.d[i] != null) {
    let v = 0;
    const kv = st.k[i], dv = st.d[i];
    if (kv < 20 && kv > dv) v = 1;
    else if (kv < 20) v = 0.5;
    else if (kv > 80 && kv < dv) v = -1;
    else if (kv > 80) v = -0.5;
    else v = kv > dv ? 0.25 : -0.25;
    votes.push({ name: 'Estocástico', value: '', vote: v, weight: 10 });
  }

  if (bb.up[i] != null) {
    let v = 0;
    const range = bb.up[i] - bb.lo[i];
    const pos = range > 0 ? (last - bb.lo[i]) / range : 0.5;
    if (pos <= 0.05) v = 1;
    else if (pos <= 0.25) v = 0.5;
    else if (pos >= 0.95) v = -1;
    else if (pos >= 0.75) v = -0.5;
    votes.push({ name: 'Bollinger', value: '', vote: v, weight: 10 });
  }

  if (vw[i] != null) {
    const above = last > vw[i];
    const dist = Math.abs(last - vw[i]) / vw[i];
    const v = dist < 0.0005 ? 0 : (above ? 0.7 : -0.7);
    votes.push({ name: 'VWAP', value: '', vote: v, weight: 10 });
  }

  {
    const volWin = cs.slice(Math.max(0, i - 20), i);
    const volAvg = volWin.length ? volWin.reduce((s, x) => s + x.v, 0) / volWin.length : 0;
    const lastVol = cs[i].v;
    const bull = cs[i].c >= cs[i].o;
    let v = 0;
    if (volAvg > 0 && lastVol > volAvg * 1.5) v = bull ? 0.8 : -0.8;
    else if (volAvg > 0 && lastVol < volAvg * 0.5) v = 0;
    else v = bull ? 0.2 : -0.2;
    votes.push({ name: 'Volume', value: '', vote: v, weight: 10 });
  }

  return { votes, trendTxt };
}

function scoreOf(votes) {
  const totalW = votes.reduce((s, x) => s + x.weight, 0);
  return totalW ? Math.round(votes.reduce((s, x) => s + x.vote * x.weight, 0) / totalW * 100) : 0;
}

function classify(score) {
  if (score >= 40) return { cls: 'buy', label: 'COMPRA FORTE' };
  if (score >= 15) return { cls: 'buy', label: 'COMPRA' };
  if (score <= -40) return { cls: 'sell', label: 'VENDA FORTE' };
  if (score <= -15) return { cls: 'sell', label: 'VENDA' };
  return { cls: 'neutral', label: 'AGUARDE' };
}

function analyzeSignals(cs) {
  const ind = computeInd(cs);
  const i = cs.length - 1;
  const { votes, trendTxt } = votesAt(cs, ind, i);
  const score = scoreOf(votes);
  let { cls, label } = classify(score);
  const adxV = ind.dmi.adx[i];
  if (adxV != null && adxV < ADX_MIN && cls !== 'neutral') { cls = 'neutral'; label = 'AGUARDE'; }
  return { votes, score, cls, label, trendTxt, adxV, atr: ind.a[i], piv: pivots(cs) };
}

function trendOf(cs) {
  const c = closes(cs);
  const i = c.length - 1;
  const e9v = ema(c, 9)[i], e21a = ema(c, 21), e50v = ema(c, 50)[i];
  const e21v = e21a[i], slope = e21v != null && e21a[i - 3] != null ? e21v - e21a[i - 3] : 0;
  const last = c[i];
  if (e9v == null || e21v == null || e50v == null) return { dir: 0, txt: 'indefinida' };
  if (e9v > e21v && e21v > e50v && last > e21v) return { dir: 1, txt: 'ALTA' };
  if (e9v < e21v && e21v < e50v && last < e21v) return { dir: -1, txt: 'BAIXA' };
  if (e9v > e21v && slope > 0) return { dir: 0.5, txt: 'alta moderada' };
  if (e9v < e21v && slope < 0) return { dir: -0.5, txt: 'baixa moderada' };
  return { dir: 0, txt: 'lateral' };
}

function applyHtfGate(res, htfInfo) {
  if (res.cls === 'buy' && htfInfo.dir < 0) { res.cls = 'neutral'; res.label = 'AGUARDE'; }
  else if (res.cls === 'sell' && htfInfo.dir > 0) { res.cls = 'neutral'; res.label = 'AGUARDE'; }
}

function backtest(cs) {
  const ind = computeInd(cs);
  const results = [];
  let pos = null;
  for (let i = 60; i < cs.length; i++) {
    if (pos) {
      const hi = cs[i].h, lo = cs[i].l;
      if (pos.side === 'compra') {
        if (lo <= pos.stop) { pos.r += pos.size * ((pos.stop - pos.entry) / pos.risk); results.push(pos.r); pos = null; continue; }
        if (!pos.half && hi >= pos.t1) { pos.r += 0.5 * 1.5; pos.size = 0.5; pos.half = true; pos.stop = pos.entry; }
        if (hi >= pos.t2) { pos.r += pos.size * 2.5; results.push(pos.r); pos = null; }
      } else {
        if (hi >= pos.stop) { pos.r += pos.size * ((pos.entry - pos.stop) / pos.risk); results.push(pos.r); pos = null; continue; }
        if (!pos.half && lo <= pos.t1) { pos.r += 0.5 * 1.5; pos.size = 0.5; pos.half = true; pos.stop = pos.entry; }
        if (lo <= pos.t2) { pos.r += pos.size * 2.5; results.push(pos.r); pos = null; }
      }
      continue;
    }
    const adxV = ind.dmi.adx[i];
    if (adxV == null || adxV < ADX_MIN) continue;
    const score = scoreOf(votesAt(cs, ind, i).votes);
    if (Math.abs(score) < 15) continue;
    const a = ind.a[i];
    if (!a) continue;
    const entry = cs[i].c, risk = 1.5 * a;
    pos = score > 0
      ? { side: 'compra', entry, risk, stop: entry - risk, t1: entry + 1.5 * risk, t2: entry + 2.5 * risk, size: 1, half: false, r: 0 }
      : { side: 'venda', entry, risk, stop: entry + risk, t1: entry - 1.5 * risk, t2: entry - 2.5 * risk, size: 1, half: false, r: 0 };
  }
  if (pos) {
    const last = cs[cs.length - 1].c;
    pos.r += pos.size * ((pos.side === 'compra' ? last - pos.entry : pos.entry - last) / pos.risk);
    results.push(pos.r);
  }
  const n = results.length;
  const totalR = results.reduce((s, r) => s + r, 0);
  return { n, winRate: n ? results.filter(r => r > 0).length / n * 100 : null, totalR, avgR: n ? totalR / n : null };
}

/* ============================== varredura e notificação ============================== */
async function scanOne(sym) {
  const htfName = HTF_MAP[TF];
  const [cs, csH] = await Promise.all([
    fetchKlines(sym, TF),
    htfName ? fetchKlines(sym, htfName).catch(() => null) : null,
  ]);
  if (cs.length < 60) throw new Error('poucos dados');
  const res = analyzeSignals(cs);
  const htfInfo = (csH && csH.length > 60) ? trendOf(csH) : null;
  if (htfInfo) applyHtfGate(res, htfInfo);
  const last = cs[cs.length - 1].c;
  const a = res.atr || last * 0.005;
  let plan = null;
  if (res.cls === 'buy') {
    const stop = last - 1.5 * a;
    plan = { entry: last, stop, t1: last + 1.5 * (last - stop), t2: last + 2.5 * (last - stop) };
  } else if (res.cls === 'sell') {
    const stop = last + 1.5 * a;
    plan = { entry: last, stop, t1: last - 1.5 * (stop - last), t2: last - 2.5 * (stop - last) };
  }
  return { sym, price: last, res, htfInfo, bt: backtest(cs), plan };
}

function buildMessage(signals, totalOk, fails) {
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const lines = [`📡 <b>Radar DayTrade</b> · ${now}`, `Gráfico ${TF} · filtro ${HTF_MAP[TF]} · ${totalOk} criptos analisadas`, ''];
  for (const s of signals) {
    const emoji = s.res.cls === 'buy' ? '🟢' : '🔴';
    const btTxt = s.bt.n ? `${s.bt.avgR >= 0 ? '+' : ''}${s.bt.avgR.toFixed(2)}R médio × ${s.bt.n} trades` : 'sem dados';
    const btWarn = s.bt.n && s.bt.avgR < 0 ? ' ⚠ backtest negativo neste ativo' : '';
    lines.push(`${emoji} <b>${s.res.label}</b> em <b>${s.sym}</b> — força ${s.res.score > 0 ? '+' : ''}${s.res.score}`);
    lines.push(`   Preço: ${formatPrice(s.price)} · ${TF} ${s.res.trendTxt} · ${HTF_MAP[TF]} ${s.htfInfo ? s.htfInfo.txt : '—'}`);
    lines.push(`   Backtest: ${btTxt}${btWarn}`);
    if (s.plan) {
      lines.push(`   Plano: entrada ${formatPrice(s.plan.entry)} · stop ${formatPrice(s.plan.stop)}`);
      lines.push(`   Alvo 1: ${formatPrice(s.plan.t1)} · Alvo 2: ${formatPrice(s.plan.t2)}`);
    }
    lines.push('');
  }
  if (fails) lines.push(`(${fails} ativo(s) falharam no escaneamento)`);
  lines.push('⚠ Análise automática educacional — não é recomendação de investimento. Confirme na ferramenta antes de operar.');
  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('Configure os secrets TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no repositório (Settings → Secrets and variables → Actions).');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram recusou a mensagem: ' + JSON.stringify(j));
}

async function main() {
  console.log(`Radar DayTrade · ${SYMBOLS.length} ativos · ${TF} (filtro ${HTF_MAP[TF]})`);
  const settled = await Promise.allSettled(SYMBOLS.map(scanOne));
  const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  const fails = settled.length - ok.length;
  settled.forEach((s, i) => {
    if (s.status === 'rejected') console.log(`  ${SYMBOLS[i]}: FALHOU — ${s.reason.message}`);
    else console.log(`  ${s.value.sym}: ${s.value.res.label} (força ${s.value.res.score}, ${TF} ${s.value.res.trendTxt})`);
  });
  const signals = ok.filter(r => r.res.cls !== 'neutral');
  if (!signals.length) {
    console.log('Nenhuma oportunidade encontrada — nenhuma notificação enviada.');
    return;
  }
  signals.sort((a, b) => Math.abs(b.res.score) - Math.abs(a.res.score));
  const msg = buildMessage(signals, ok.length, fails);
  await sendTelegram(msg);
  console.log(`Notificação enviada com ${signals.length} oportunidade(s).`);
}

if (require.main === module) {
  main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
} else {
  module.exports = { analyzeSignals, trendOf, applyHtfGate, backtest, scanOne, buildMessage, main, fetchKlines, SYMBOLS };
}

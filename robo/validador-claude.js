#!/usr/bin/env node
'use strict';
/*
 * Validador Claude Conservador — paper trading 24/7 (portão 2 do roadmap)
 * ----------------------------------------------------------------------
 * Roda a MESMA lógica do modo "🤖 Claude conservador" (daytrade-claude.html),
 * mas no servidor (GitHub Actions, num cron), de modo que opera mesmo sem
 * nenhuma aba aberta — acumulando uma amostra estatística confiável antes de
 * qualquer execução real (testnet/dinheiro).
 *
 * O motor de sinais é reaproveitado VERBATIM de robo/radar.js (mesmas funções
 * de indicadores, votos, ADX, filtro multi-tempo e backtest) — zero divergência.
 *
 * Esta versão é SÓ SIMULAÇÃO (paper): nenhuma ordem real é enviada a lugar
 * nenhum. A ponte para o testnet da Binance (portão 3) está documentada no
 * fim do arquivo, e só deve ser ligada quando o portão 2 passar.
 *
 * Persistência do estado:
 *   - Nuvem (Actions): Gist secreto, via env STATE_GIST_ID + GH_GIST_TOKEN.
 *   - Local (seu PC):  arquivo robo/estado-validador.json (basta `node` rodar).
 *
 * Notificação opcional no Telegram: env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 * (reaproveita os mesmos secrets do radar).
 */

const fs = require('fs');
const path = require('path');
const engine = require('./radar.js'); // fetchKlines, analyzeSignals, trendOf, backtest, SYMBOLS

/* ===================== config: porte 1:1 do Claude conservador ===================== */
const TF = '1h', HTF = '4h';
const SIM_START = 10000;        // saldo inicial virtual
const SIM_FEE = 0.001;          // 0,1% por ponta, como na corretora
const RISK_PCT = 1;             // AUTO_RISK
const MAX_POS = 2;              // AUTO_MAX_POS
const MIN_SCORE = 25;           // AUTO_MIN_SCORE
const MIN_ADX = 20;             // AUTO_MIN_ADX
const MIN_BT = 5;               // AUTO_MIN_BT
const REVENGE_LOCK_MIN = 30;    // trava anti-revenge após um stop
const SYMBOLS = engine.SYMBOLS;
const STATE_FILE = path.join(__dirname, 'estado-validador.json');
const GIST_ID = process.env.STATE_GIST_ID || '';
const GIST_TOKEN = process.env.GH_GIST_TOKEN || '';
const GIST_FILE = 'estado-validador.json';

/* ===================== utilidades ===================== */
function fmt(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  const dec = abs >= 100 ? 2 : abs >= 10 ? 3 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 8;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function freshState() {
  return { startBalance: SIM_START, balance: SIM_START, positions: [], history: [], log: [], lockUntil: 0, updatedAt: Date.now() };
}
const _notifyQueue = [];
function queueNotify(text) { _notifyQueue.push(text); }
function logEvent(st, kind, txt) {
  st.log.unshift({ t: Date.now(), kind, txt });
  st.log = st.log.slice(0, 200);
  console.log(`  ${kind === 'open' ? '▶' : kind === 'win' ? '✅' : kind === 'loss' ? '❌' : '·'} ${txt}`);
}

/* ===================== persistência ===================== */
async function loadState() {
  if (GIST_ID) {
    try {
      const headers = { Accept: 'application/vnd.github+json' };
      if (GIST_TOKEN) headers.Authorization = 'Bearer ' + GIST_TOKEN;
      const r = await fetch('https://api.github.com/gists/' + GIST_ID, { headers });
      if (r.ok) {
        const j = await r.json();
        const f = j.files && j.files[GIST_FILE];
        if (f && f.content) return normalize(JSON.parse(f.content));
      } else {
        console.error('Aviso: não consegui ler o Gist (' + r.status + ') — começando do zero.');
      }
    } catch (e) { console.error('Aviso: falha ao ler o Gist —', e.message); }
    return freshState();
  }
  try { return normalize(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (e) { return freshState(); }
}
function normalize(st) {
  st.startBalance = st.startBalance ?? SIM_START;
  st.positions = Array.isArray(st.positions) ? st.positions : [];
  st.history = Array.isArray(st.history) ? st.history : [];
  st.log = Array.isArray(st.log) ? st.log : [];
  st.lockUntil = st.lockUntil || 0;
  return st;
}
async function saveState(st) {
  st.updatedAt = Date.now();
  const body = JSON.stringify(st, null, 2);
  if (GIST_ID && GIST_TOKEN) {
    const r = await fetch('https://api.github.com/gists/' + GIST_ID, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + GIST_TOKEN, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: body } } }),
    });
    if (!r.ok) throw new Error('Gist save respondeu ' + r.status);
    return;
  }
  fs.writeFileSync(STATE_FILE, body);
}

/* ===================== gestão de posições (porte de simUpdate/simCloseQty) ===================== */
function closeQty(st, pos, qty, price, reason) {
  const fee = (pos.entry + price) * qty * SIM_FEE;       // taxa de entrada + saída desta parte
  const pnl = (pos.side === 'compra' ? price - pos.entry : pos.entry - price) * qty - fee;
  st.balance += pnl;
  if (reason === 'stop-loss') st.lockUntil = Date.now() + REVENGE_LOCK_MIN * 60000;
  const r = pos.riskPerUnit > 0 ? pnl / (pos.riskPerUnit * qty) : 0;
  st.history.unshift({ closedAt: Date.now(), symbol: pos.symbol, side: pos.side, qty, entry: pos.entry, exit: price, pnl, reason, r });
  pos.qty -= qty;
  logEvent(st, pnl >= 0 ? 'win' : 'loss', `Fechei ${pos.side} ${pos.symbol} (${reason}): ${pnl >= 0 ? '+' : ''}$ ${pnl.toFixed(2)} (${r >= 0 ? '+' : ''}${r.toFixed(2)}R)`);
  queueNotify(`${pnl >= 0 ? '✅' : '❌'} Fechei ${pos.side.toUpperCase()} ${pos.symbol} (${reason}): ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} · ${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
}
// percorre os candles desde a entrada (ou desde a última checagem); stop/alvos
// atingidos enquanto ninguém olhava são processados retroativamente
function manage(st, sym, cs) {
  const period = cs.length > 1 ? cs[1].t - cs[0].t : 0;
  for (const pos of st.positions) {
    if (pos.symbol !== sym || pos.qty <= 0) continue;
    for (const candle of cs) {
      if (candle.t + period <= pos.openedAt) continue;            // candle terminou antes da entrada
      if (pos.lastT != null && candle.t < pos.lastT) continue;    // já processado
      const openedThisCandle = pos.openedAt > candle.t;           // evita look-ahead no candle da entrada
      const hi = openedThisCandle ? candle.c : candle.h;
      const lo = openedThisCandle ? candle.c : candle.l;
      if (pos.side === 'compra') {
        if (lo <= pos.stop) { closeQty(st, pos, pos.qty, pos.stop, pos.halfTaken ? 'stop no 0x0' : 'stop-loss'); break; }
        if (!pos.halfTaken && hi >= pos.t1) { closeQty(st, pos, pos.qty / 2, pos.t1, 'alvo 1'); pos.halfTaken = true; pos.stop = pos.entry; }
        if (pos.qty > 0 && hi >= pos.t2) { closeQty(st, pos, pos.qty, pos.t2, 'alvo 2'); break; }
      } else {
        if (hi >= pos.stop) { closeQty(st, pos, pos.qty, pos.stop, pos.halfTaken ? 'stop no 0x0' : 'stop-loss'); break; }
        if (!pos.halfTaken && lo <= pos.t1) { closeQty(st, pos, pos.qty / 2, pos.t1, 'alvo 1'); pos.halfTaken = true; pos.stop = pos.entry; }
        if (pos.qty > 0 && lo <= pos.t2) { closeQty(st, pos, pos.qty, pos.t2, 'alvo 2'); break; }
      }
    }
    if (pos.qty > 0 && cs.length) pos.lastT = cs[cs.length - 1].t;
  }
  st.positions = st.positions.filter(p => p.qty > 0);
}

/* ===================== abertura (porte de autoOpen — alavancagem 1×) ===================== */
function openPosition(st, c, side) {
  const last = c.cs[c.cs.length - 1].c;
  const a = c.res.atr || last * 0.005;
  const stop = side === 'compra' ? last - 1.5 * a : last + 1.5 * a;
  const t1 = side === 'compra' ? last + 1.5 * (last - stop) : last - 1.5 * (stop - last);
  const t2 = side === 'compra' ? last + 2.5 * (last - stop) : last - 2.5 * (stop - last);
  const perUnit = Math.abs(last - stop);
  if (perUnit <= 0) return false;
  const allocated = st.positions.reduce((s, p) => s + p.qty * p.entry, 0);
  const free = st.balance - allocated;            // sem alavancagem: soma das posições ≤ saldo
  if (free <= 0) return false;
  let qty = (st.balance * RISK_PCT / 100) / perUnit;
  if (qty * last > free) qty = free / last;
  if (qty <= 0) return false;
  st.positions.push({
    id: Date.now() + Math.floor(Math.random() * 1000), symbol: c.sym, side,
    qty, entry: last, stop, t1, t2, riskPerUnit: perUnit, halfTaken: false, openedAt: Date.now(), lastT: null,
  });
  logEvent(st, 'open', `Abri ${side.toUpperCase()} ${c.sym} a ${fmt(last)} · força ${c.res.score > 0 ? '+' : ''}${c.res.score}, ${TF} ${c.res.trendTxt}, ${HTF} ${c.htfInfo.txt}, ADX ${c.res.adxV.toFixed(0)}, bt ${c.bt.avgR >= 0 ? '+' : ''}${c.bt.avgR.toFixed(2)}R×${c.bt.n} · stop ${fmt(stop)} alvos ${fmt(t1)}/${fmt(t2)}`);
  queueNotify(`▶ Abri ${side.toUpperCase()} ${c.sym} a ${fmt(last)} · stop ${fmt(stop)} · alvos ${fmt(t1)}/${fmt(t2)}`);
  return true;
}

/* ===================== loop principal ===================== */
async function run() {
  const st = await loadState();
  console.log(`Validador Claude conservador · ${TF} (filtro ${HTF}) · saldo $ ${st.balance.toFixed(2)} · ${st.positions.length} posição(ões) aberta(s)`);

  // 1) gerencia posições abertas
  for (const sym of [...new Set(st.positions.map(p => p.symbol))]) {
    try { manage(st, sym, await engine.fetchKlines(sym, TF)); }
    catch (e) { console.error(`  ${sym}: falha ao gerenciar — ${e.message}`); }
  }

  // 2) procura entradas novas (respeitando trava, teto de posições e os critérios do conservador)
  const locked = st.lockUntil && Date.now() < st.lockUntil;
  if (locked) {
    console.log(`  trava anti-revenge ativa por mais ${Math.ceil((st.lockUntil - Date.now()) / 60000)} min — sem novas entradas`);
  } else if (st.positions.length >= MAX_POS) {
    console.log(`  carteira cheia (${st.positions.length}/${MAX_POS}) — só gerenciando`);
  } else {
    const settled = await Promise.allSettled(SYMBOLS.map(async sym => {
      const [cs, csH] = await Promise.all([engine.fetchKlines(sym, TF), engine.fetchKlines(sym, HTF).catch(() => null)]);
      if (cs.length < 60) throw new Error('poucos dados');
      const res = engine.analyzeSignals(cs);
      const htfInfo = (csH && csH.length > 60) ? engine.trendOf(csH) : null;
      return { sym, cs, res, htfInfo, bt: engine.backtest(cs) };
    }));
    const rows = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    const picks = rows.filter(r => {
      if (r.res.cls === 'neutral') return false;
      if (Math.abs(r.res.score) < MIN_SCORE) return false;
      const aligned = r.htfInfo && ((r.res.cls === 'buy' && r.htfInfo.dir > 0) || (r.res.cls === 'sell' && r.htfInfo.dir < 0));
      if (!aligned) return false;
      if (r.res.adxV == null || r.res.adxV < MIN_ADX) return false;
      if (!r.bt.n || r.bt.n < MIN_BT || r.bt.avgR <= 0) return false;
      return true;
    }).sort((a, b) => Math.abs(b.res.score) - Math.abs(a.res.score));
    let opened = 0;
    for (const c of picks) {
      if (st.positions.length >= MAX_POS) break;
      const side = c.res.cls === 'buy' ? 'compra' : 'venda';
      if (st.positions.some(p => p.symbol === c.sym)) continue;       // já posicionado neste ativo
      if (st.positions.some(p => p.side === side)) continue;          // máx. 1 por direção (correlação)
      if (openPosition(st, c, side)) opened++;
    }
    console.log(`  ${rows.length} criptos analisadas — ${opened ? 'abri ' + opened + ' posição(ões)' : 'nenhuma passou nos critérios'}`);
  }

  await saveState(st);
  await flushNotify();
  printSummary(st);
}

function printSummary(st) {
  const closed = st.history;
  const wins = closed.filter(h => h.pnl > 0).length;
  const winRate = closed.length ? (wins / closed.length * 100).toFixed(0) + '%' : '—';
  const avgR = closed.length ? (closed.reduce((s, h) => s + h.r, 0) / closed.length).toFixed(2) + 'R' : '—';
  const ret = ((st.balance - st.startBalance) / st.startBalance * 100).toFixed(2);
  console.log(`Resumo · saldo $ ${st.balance.toFixed(2)} (${ret >= 0 ? '+' : ''}${ret}%) · ${closed.length} trades · acerto ${winRate} · R médio ${avgR} · ${st.positions.length} aberta(s)`);
}

async function flushNotify() {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || !_notifyQueue.length) return;
  const text = '🤖 <b>Validador Claude</b>\n' + _notifyQueue.join('\n');
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { console.error('Telegram falhou:', e.message); }
}

/* ===================== auto-teste offline (sem rede) ===================== */
// `node robo/validador-claude.js --selftest` valida o modelo de fill com candles sintéticos
function selftest() {
  let fail = 0;
  const assert = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); fail++; } else console.log('  ✓ ' + msg); };

  // compra que bate o alvo 2: deve fechar com lucro líquido (> 0) e R ≈ +2,5 na 2ª metade
  let st = freshState();
  st.positions.push({ id: 1, symbol: 'TEST', side: 'compra', qty: 10, entry: 100, stop: 90, t1: 115, t2: 125, riskPerUnit: 10, halfTaken: false, openedAt: 0, lastT: null });
  manage(st, 'TEST', [{ t: 1, o: 100, h: 130, l: 99, c: 128, v: 1 }, { t: 2, o: 128, h: 130, l: 127, c: 129, v: 1 }]);
  assert(st.positions.length === 0, 'compra no alvo: posição encerrada');
  assert(st.balance > st.startBalance, 'compra no alvo: saldo subiu (' + st.balance.toFixed(2) + ')');
  assert(st.history.some(h => h.reason === 'alvo 1') && st.history.some(h => h.reason === 'alvo 2'), 'compra no alvo: registrou alvo 1 e alvo 2');

  // compra que bate o stop: deve fechar no prejuízo e ligar a trava anti-revenge
  st = freshState();
  st.positions.push({ id: 2, symbol: 'TEST', side: 'compra', qty: 10, entry: 100, stop: 90, t1: 115, t2: 125, riskPerUnit: 10, halfTaken: false, openedAt: 0, lastT: null });
  manage(st, 'TEST', [{ t: 1, o: 100, h: 101, l: 85, c: 88, v: 1 }]);
  assert(st.positions.length === 0, 'compra no stop: posição encerrada');
  assert(st.balance < st.startBalance, 'compra no stop: saldo caiu (' + st.balance.toFixed(2) + ')');
  assert(st.lockUntil > Date.now(), 'compra no stop: trava anti-revenge ligada');

  // venda que bate o alvo: lucro
  st = freshState();
  st.positions.push({ id: 3, symbol: 'TEST', side: 'venda', qty: 10, entry: 100, stop: 110, t1: 85, t2: 75, riskPerUnit: 10, halfTaken: false, openedAt: 0, lastT: null });
  manage(st, 'TEST', [{ t: 1, o: 100, h: 101, l: 70, c: 74, v: 1 }, { t: 2, o: 74, h: 75, l: 73, c: 74, v: 1 }]);
  assert(st.balance > st.startBalance, 'venda no alvo: saldo subiu (' + st.balance.toFixed(2) + ')');

  console.log(fail ? `\nAUTO-TESTE: ${fail} falha(s).` : '\nAUTO-TESTE: tudo certo ✓');
  process.exit(fail ? 1 : 0);
}

/* ===================== entrada ===================== */
if (require.main === module) {
  if (process.argv.includes('--selftest')) selftest();
  else run().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
} else {
  module.exports = { run, manage, openPosition, closeQty, freshState };
}

/*
 * ============================ PORTÃO 3 — TESTNET (futuro) ============================
 * Quando o portão 2 passar (amostra ≥ ~30 trades, expectativa positiva em >1 regime),
 * a execução real entra AQUI, sem mexer na lógica acima:
 *   - novo módulo robo/binance-testnet.js com cliente REST assinado (HMAC-SHA256
 *     via require('crypto')) apontando para https://testnet.binance.vision;
 *   - em openPosition(): além de registrar a posição virtual, enviar a ordem real
 *     (market/limit) + ordens OCO de stop e alvo;
 *   - em closeQty(): conciliar com os fills reais devolvidos pelo testnet;
 *   - chave/segredo SÓ via env (BINANCE_TESTNET_KEY / _SECRET), nunca no código.
 * Ligado por uma env MODE=testnet, mantendo MODE=paper como padrão.
 */

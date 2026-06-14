# Validador Claude Conservador — paper trading 24/7

Roda a **mesma lógica** do modo 🤖 Claude conservador (`daytrade-claude.html`),
só que no servidor (GitHub Actions, num cron), para operar **sem nenhuma aba
aberta** e acumular uma amostra estatística confiável. É o **portão 2** do
roadmap: gerar dados de verdade, ao longo do tempo, antes de qualquer execução
real (testnet/dinheiro).

> ⚠️ É **só simulação (paper)**. Nenhuma ordem real é enviada a lugar nenhum.
> A ponte para o testnet da Binance (portão 3) está esboçada no fim do
> `validador-claude.js` e só deve ser ligada quando o portão 2 passar.

O motor de sinais é reaproveitado **verbatim** de `robo/radar.js` — os mesmos
indicadores, votos, ADX, filtro multi-tempo e backtest do site. Zero divergência.

## Como ele decide (idêntico ao Claude conservador)
- Gráfico **1h**, confirmado pela tendência do **4h**.
- Só entra com: força ≥ ±25, ADX ≥ 20, backtest do ativo positivo (≥ 5 trades),
  e a maré do 4h a favor.
- Até **2 posições** de **1%** de risco, no máximo **1 por direção** (correlação).
- Stop 1,5×ATR · parcial no alvo 1 (move stop para o 0×0) · resto no alvo 2.
- Taxa de 0,1% por ponta · trava anti-revenge de 30 min após um stop.

## Testar agora no seu PC (1 minuto)
Precisa de [Node.js](https://nodejs.org) instalado.
```bash
node robo/validador-claude.js --selftest   # valida o modelo de fill (offline)
node robo/validador-claude.js              # roda de verdade contra a Binance ao vivo
```
Localmente o estado é salvo em `robo/estado-validador.json`. Rode quantas vezes
quiser — ele continua de onde parou.

## Ligar o modo 24/7 na nuvem (GitHub Actions)
1. **Crie um Gist secreto** em <https://gist.github.com> com um arquivo chamado
   `estado-validador.json` e conteúdo `{}`. Salve como **secret gist** e copie o
   **id** do final da URL (`gist.github.com/voce/<ESSE_ID>`).
2. **Crie um token** com escopo **gist** em
   <https://github.com/settings/tokens/new?scopes=gist> (pode ser o mesmo que
   você já usou no placar, se tiver o escopo gist).
3. No repositório: **Settings → Secrets and variables → Actions → New repository
   secret** e crie:
   - `VALIDADOR_GIST_ID` → o id do passo 1
   - `VALIDADOR_GIST_TOKEN` → o token do passo 2
   - *(opcional)* `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` para receber aviso a
     cada abertura/fechamento (os mesmos do radar).
4. O agendamento só dispara quando o arquivo
   `.github/workflows/validador-claude.yml` estiver no branch **main**. Depois é
   só abrir a aba **Actions → Validador Claude Conservador → Run workflow** para
   um primeiro disparo manual.

O estado (saldo, posições, histórico, diário) fica todo no Gist — dá para abrir
no celular a qualquer momento, e nada polui o histórico do repositório.

## Importante
- Este validador é uma **trilha separada**: a conta do experimento
  (`simClaude_v1`, no navegador) continua **congelada** como grupo de controle.
  Aqui a gente pode ajustar à vontade sem sujar a comparação original.
- Cada evolução futura vira uma **versão nova** (validador-2, -3…), nunca uma
  edição da que está sendo medida.
- Educacional — não é recomendação de investimento.

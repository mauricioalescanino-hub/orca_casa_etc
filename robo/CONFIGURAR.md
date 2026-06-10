# Robô Radar DayTrade — como configurar (5 minutos)

O robô roda 4× ao dia no GitHub Actions (~08h, 12h, 16h e 20h de Brasília),
escaneia 10 criptos com o mesmo motor do `daytrade.html` e envia uma
notificação no seu Telegram quando encontra oportunidade de compra ou venda.

## Passo 1 — Criar o seu bot no Telegram

1. Abra o Telegram e procure por **@BotFather** (o oficial, com selo azul).
2. Envie o comando `/newbot`.
3. Dê um nome (ex.: `Meu Radar DayTrade`) e um username terminando em `bot`
   (ex.: `meu_radar_daytrade_bot`).
4. O BotFather responde com o **token** — algo como
   `1234567890:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-pk`. **Copie e guarde.**

## Passo 2 — Descobrir o seu chat_id

1. Procure pelo seu bot recém-criado no Telegram e toque em **Iniciar**
   (isso autoriza o bot a te mandar mensagens — sem isso nada chega!).
2. Envie qualquer mensagem para ele (ex.: "oi").
3. Abra no navegador (trocando SEU_TOKEN pelo token do passo 1):
   `https://api.telegram.org/botSEU_TOKEN/getUpdates`
4. Procure por `"chat":{"id":123456789` — esse número é o seu **chat_id**.

## Passo 3 — Cadastrar os dois códigos no GitHub

1. Abra `github.com/mauricioalescanino-hub/orca_casa_etc`.
2. **Settings → Secrets and variables → Actions → New repository secret**.
3. Crie dois secrets:
   - Nome: `TELEGRAM_BOT_TOKEN` · Valor: o token do passo 1
   - Nome: `TELEGRAM_CHAT_ID` · Valor: o número do passo 2

## Passo 4 — Testar

1. No repositório, abra a aba **Actions**.
2. Clique no workflow **Radar DayTrade** → botão **Run workflow** → Run.
3. Em ~1 minuto a execução termina. Se houver oportunidade no mercado,
   chega notificação no Telegram; se não houver, o log mostra
   "Nenhuma oportunidade encontrada" (e isso é normal — os filtros são
   rigorosos de propósito).

## Ajustes opcionais

- **Horários**: edite o `cron` em `.github/workflows/radar.yml`
  (atenção: os horários são em UTC = Brasília + 3h).
- **Tempo gráfico**: o padrão é `1h`. Para mudar, adicione no workflow,
  junto dos outros `env`: `RADAR_TF: '4h'`.

## Avisos

- O agendamento só funciona com o arquivo no branch `main` (já está).
- O GitHub pode atrasar execuções agendadas em alguns minutos — normal.
- Se o repositório ficar 60 dias sem atividade, o GitHub pausa os
  agendamentos e avisa por e-mail; basta reativar com um clique.
- Análise automática educacional — não é recomendação de investimento.

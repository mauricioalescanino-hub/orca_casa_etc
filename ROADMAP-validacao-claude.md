# Roadmap — Validação do Claude Conservador

> Documento de planejamento. **Nada aqui altera o experimento em andamento.**
> Sem chave de API, sem servidor, sem dinheiro real até os portões abaixo serem cumpridos.

## Por que o Claude conservador
- Lidera em patrimônio **e** tem o menor drawdown máximo da mesa — o melhor retorno
  ajustado ao risco entre os 5 robôs.
- Ressalva honesta: até agora são **poucos trades fechados**. Boa parte da vantagem vem
  de ter operado pouco em mercado lateral. "Acertar ao ficar de fora" ainda não é
  "vantagem estatística comprovada".

## Princípio que protege o experimento: fork, nunca edição
- A conta do experimento (`simClaude_v1`) continua **congelada** = grupo de controle.
- Toda evolução acontece numa **trilha separada de validação**, que podemos ajustar à
  vontade. Assim a comparação original segue limpa e o "ajustar à medida que temos dados"
  nunca contamina a medição.

## Portões de promoção (cada um só abre quando o anterior passa)
1. **Desenho (agora)** — arquitetura e critérios no papel. Sem chave, sem servidor, sem dinheiro.
2. **Amostra estatística** — antes de qualquer execução real, exigir:
   - ≥ 30 trades fechados na simulação atual;
   - cobertura de ≥ 2 regimes de mercado (alta / lateral / queda);
   - expectativa positiva sustentada: R médio > 0 e profit factor > ~1,3;
   - drawdown máximo dentro do tolerável.
3. **Testnet** — execução real contra o motor de testes da Binance: captura slippage,
   latência, rejeição de ordem e **funding/liquidação** (que a simulação atual ignora).
   Requer backend rodando 24/7 + chave guardada no servidor.
4. **Dinheiro real pequeno** — só se os portões 2 e 3 passarem, e começando minúsculo.

## Arquitetura (a montar quando chegarmos no portão 3)
- Um **backend pequeno** (worker Node ou Python) rodando 24/7 — não o navegador, que só
  opera com a aba aberta.
- Chave de API **testnet** guardada no servidor; **nunca** exposta na página.
- Loop: puxa candles → roda a **mesma** lógica do conservador → envia ordem ao testnet →
  registra o fill real.
- Ganhos de brinde: funding/liquidação reais e **estado centralizado no servidor**, o que
  resolve o sync PC↔celular sem o truque do Gist.

## O loop de ajuste ("ajustar à medida que temos dados")
- Cada ajuste vira uma **versão nova em paralelo** (conservador-2, -3, …), nunca uma
  edição da versão que está sendo medida.
- Decisão sempre guiada por dado acumulado, não por um dia bom ou ruim.

## O que NÃO estamos fazendo ainda
- Nenhuma chave, nenhum servidor, nenhum centavo real. O experimento dos 5 robôs segue
  intocado. Este documento é só o mapa para quando o campeão estiver comprovado.

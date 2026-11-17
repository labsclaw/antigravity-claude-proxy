# Manutenção do fork local

## Atualização de 17/11/2026

Integrado upstream tag v3.1.1 (252da0d), com dependências de produção atualizadas,
User-Agent Hub, registro de modelos por metadados, cache persistente de assinaturas,
contagem de uso e posicionamento do prompt corrigido para evitar 429 opaco.
A tag upstream ainda declarava 2.7.7 no package.json; este fork declara 3.1.1.

Preservados: ponte Grok e seus endpoints Anthropic/OpenAI, autenticação local,
UI de contas/modelos Grok, suporte GPT-OSS, afinidade Session Hybrid por cliente,
conversa e modelo, contabilização de leases e timeout do health.
A quota crítica conhecida permanece bloqueada no Session Hybrid mesmo antiga,
conforme contrato/teste original. Quota desconhecida não equivale a saldo zero.
A política não altera contas, quotas persistidas nem modelos/fallbacks do cliente.

Sessões sem ID explícito usam chave derivada por cliente/conversa/modelo/conta
estável após reinício. Sessões explicitamente identificadas mantêm TTL e LRU locais.
As assinaturas ficam fora do Git na pasta de dados do usuário. No POSIX o arquivo
é escrito com modo 0600; Windows depende das ACLs do perfil, não dos bits POSIX.

## Verificação

- Node >=22.19.0; CI usa Node 24 no Windows e Linux.
- npm ci
- npm run test:offline (17 suítes sem chamadas a provedores).
- npm run build:css
- npm audit --omit=dev --audit-level=high
- node -e "const D=require('better-sqlite3');new D(':memory:').close()"
- Após ativar: catálogo, inferência via Gateway e leitura de ferramenta sem fallback.

A auditoria completa em 17/11 indicou 10 alertas high transitivos de desenvolvimento
via picomatch <=4.0.7. O registro retornou 4.0.7 como última versão; ^4.0.8 não existe.
Não aplicar override inexistente nem migrar Tailwind major somente para ocultar o
alerta. Dependências de produção: zero achados nessa verificação. Build deve receber
apenas fontes/globs confiáveis; reavaliar quando o registro publicar uma correção.

## Ativação e recuperação

O serviço PM2 antigravity-proxy usa o checkout canônico
C:/Users/ClawLabs/antigravity-claude-proxy, não a instalação npm global.
Integrar por fast-forward após CI/revisão e reinstalar dependências antes do restart.
Validar a revisão e o caminho executados, não somente o número mostrado pela CLI.

Ponto de recuperação anterior: 6741e6d, preservando o backport do prompt e Grok.
Em falha, parar somente este serviço, voltar a essa revisão em branch de recuperação,
reinstalar com npm ci e reiniciar. Não usar git reset --hard em checkout com edições.
Não restaurar snapshots de credenciais por causa de falha de código.

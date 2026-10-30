# Prestação de contas de deslocamentos (versão web)

Gera a declaração de deslocamento a serviço com quilometragem de ida e retorno, valor de
ressarcimento, links do Google Maps e mapas das rotas, a partir da planilha padrão.

- **docs/**: o site (GitHub Pages). Funciona inteiro no navegador.
- **worker/**: um pequeno proxy (Cloudflare Workers, plano gratuito) que guarda a chave da
  Geoapify. É ele que torna possível todos usarem a mesma chave sem que ela seja exposta.

## Por que existe o proxy

Um site no GitHub Pages é público: qualquer coisa que esteja no código do site pode ser vista
por qualquer pessoa (inclusive uma chave de API "escondida" em JavaScript). Por isso a chave
**não está no site nem no repositório**. Ela fica guardada como segredo no Cloudflare, e o site
pede ao proxy que faça as consultas.

```
Navegador (GitHub Pages) ──► Proxy (Cloudflare Worker, com a chave) ──► Geoapify
        sem chave                    só 3 operações permitidas
```

## Publicação (uma vez, cerca de 20 minutos)

### 1. Chave da Geoapify
Em https://myprojects.geoapify.com crie um projeto e copie a chave (de preferência, uma chave
nova, usada só neste sistema).

### 2. Site no GitHub Pages
1. Crie um repositório no GitHub e envie todo o conteúdo desta pasta.
2. Em **Settings → Pages**, escolha *Deploy from a branch*, branch `main`, pasta `/docs`.
3. Anote o endereço do site, por exemplo `https://seu-usuario.github.io/prestacao/`.
   A **origem** usada no passo 3 é só o começo: `https://seu-usuario.github.io` (sem a pasta
   e sem barra no final).

### 3. Proxy no Cloudflare Workers
Crie uma conta gratuita em https://dash.cloudflare.com. Depois escolha **uma** das formas:

**Forma A: pela linha de comando (recomendada: inclui o limite de requisições por IP)**
Requer Node.js instalado.
```bash
cd worker
# edite wrangler.toml: ALLOWED_ORIGINS = "https://seu-usuario.github.io"
npx wrangler login
npx wrangler deploy
npx wrangler secret put GEOAPIFY_KEY      # cole a chave da Geoapify
npx wrangler secret put ACCESS_CODE       # opcional, mas recomendado (ver Segurança)
```

**Forma B: pelo painel, sem instalar nada**
1. *Workers & Pages → Create → Create Worker*, dê o nome `prestacao-deslocamentos` e clique em *Deploy*.
2. *Edit code*: apague o conteúdo, cole o arquivo `worker/worker.js` inteiro e clique em *Deploy*.
3. *Settings → Variables and Secrets*:
   - `ALLOWED_ORIGINS` (tipo *Text*): `https://seu-usuario.github.io`
   - `GEOAPIFY_KEY` (tipo *Secret*): a chave da Geoapify
   - `ACCESS_CODE` (tipo *Secret*, opcional): o código de acesso da equipe

Anote o endereço do Worker, por exemplo `https://prestacao-deslocamentos.seu-subdominio.workers.dev`.

### 4. Ligar o site ao proxy
Edite `docs/config.js` e coloque o endereço do Worker em `proxyUrl`. Faça o commit.
Em um minuto o site estará pronto.

### 5. Teste
Abra o site, clique em *Configurações*, preencha seus dados e o valor por km, importe a planilha
e gere o relatório. Se você ativou o `ACCESS_CODE`, o sistema pedirá o código na primeira vez.

## Segurança

**Onde a chave existe:** somente nos segredos do Cloudflare. Ela não está no repositório, não é
enviada ao navegador e não aparece em nenhuma resposta do proxy.

**O que impede o uso indevido do proxy:**
- Só são aceitas requisições vindas do endereço do seu site (`ALLOWED_ORIGINS`).
- O proxy faz apenas três coisas, com parâmetros fixos: localizar endereços no Brasil, calcular
  rota de carro entre dois pontos no Brasil e gerar um mapa em tamanho fixo. Não serve como
  acesso genérico à Geoapify.
- Limite de 60 consultas por minuto por IP (forma A).
- Código de acesso (`ACCESS_CODE`): opcional, digitado uma única vez em cada dispositivo.

**Limite honesto:** a verificação de origem barra outros sites, mas alguém com conhecimento
técnico consegue imitá-la fora do navegador. Por isso o **código de acesso é recomendado**: sem
ele, quem descobrir o endereço do proxy pode consumir a sua cota. Mesmo nesse pior caso, a chave
continua protegida e, no plano gratuito da Geoapify (sem cartão), o efeito é só esgotar os
créditos do dia, sem custo.

**Se suspeitar de abuso:** troque o código (`npx wrangler secret put ACCESS_CODE` ou pelo painel)
e avise a equipe. Se suspeitar que a chave vazou, gere uma nova na Geoapify, apague a antiga e
atualize `GEOAPIFY_KEY`.

**Nunca** coloque a chave em `config.js`, no `wrangler.toml` ou em qualquer arquivo do repositório.

## Privacidade
- Dados cadastrais (nome, matrícula, gestor, valor/km) e relatórios ficam apenas no navegador de
  cada usuário (localStorage e IndexedDB). Limpar os dados do navegador apaga os relatórios
  guardados; salve em PDF o que for entregar.
- Para calcular as rotas, somente os endereços passam pelo proxy até a Geoapify. O proxy não
  grava nada.
- O site usa uma política de segurança de conteúdo (CSP) que só permite conexões com o próprio
  site e com `*.workers.dev`. Se usar um domínio próprio no Worker, inclua-o em `connect-src` no
  `docs/index.html`.

## Diferenças em relação à versão de servidor local
- Cada pessoa usa com os próprios dados; não há configuração compartilhada.
- Total de km = soma da ida e do retorno exibidos (antes podia diferir em 0,1 km por arredondamento).
- Aviso quando um endereço foi reconhecido com baixa confiança.
- Se o mapa com ruas não puder ser obtido, a rota é desenhada sem o fundo de ruas, com aviso.
- Botão para adicionar linhas manualmente na conferência.

Rotas e mapas: Geoapify. Dados cartográficos © OpenStreetMap contributors.

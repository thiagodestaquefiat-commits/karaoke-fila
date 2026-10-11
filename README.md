# Karaokê Fila

Pedido de música por QR code, fila ao vivo e painel do DJ.

- **Cliente (celular)** · `web/index.html`: entra com o Google, busca no YouTube, escolhe a versão, entra na fila e vê **"Sua vez em ~20 min (por volta de 01:40)"**. Recebe um aviso quando faltam 2 músicas ou 8 minutos.
- **DJ** · `web/dj.html`: player do YouTube, botão **Próxima**, fila com o horário previsto de cada pessoa, **duração total da fila** e a hora em que ela termina. O DJ pode subir, descer, mandar para o topo ou para o fim, marcar **"Não está aqui"** ou remover. Também abre e fecha os pedidos.
- **TV** · `web/tv.html`: quem está no palco, os próximos 3 e o QR code para pedir.

Tudo se atualiza em tempo real: quando o DJ mexe na fila, o celular de cada pessoa e a TV mudam sozinhos.

---

## Ver funcionando agora (modo demonstração)

Enquanto o `web/js/config.js` estiver com a URL de exemplo, o app roda em **modo demonstração**: tudo funciona dentro do navegador, com dados de exemplo e sem Supabase. Abra **`web/demo.html`**, que mostra o celular, o painel do DJ e a TV lado a lado e ligados na mesma fila. Com o app já configurado, dá para forçar a demonstração colocando `?demo=1` no endereço de qualquer tela.

No modo demo, os vídeos não tocam, a busca usa um catálogo de exemplo e recarregar a página volta a fila ao começo. As regras da fila são as mesmas do banco.

## Como funciona

```
Celular ──(login Google)──► Supabase Auth
Celular ──(busca)─────────► Edge Function youtube-search ──► cache no banco
                                                         └─► YouTube Data API (se não tiver no cache)
Celular ──(pedido)────────► request_song()  ─┐
DJ ──────(reordenar etc.)─► dj_move() ...   ─┼─► tabela requests ──(Realtime)──► celulares, DJ, TV
```

**Regra de ouro da segurança:** ninguém escreve direto nas tabelas. Todo pedido e toda ação do DJ passa por uma função no banco (`request_song`, `dj_next`, `dj_move` etc.) que confere as regras: se a pessoa está logada, se é DJ, o limite por pessoa e se a música já está na fila. Assim, mesmo alguém mexendo no navegador não consegue furar a fila.

### Estimativa de tempo (`web/js/estimate.js`)

```
tempo até cantar = o que falta da música atual
                 + duração de cada música na frente
                 + folga entre músicas × número de trocas
```

- A duração de cada vídeo vem do YouTube no momento da busca e fica salva no pedido.
- A **folga** (padrão 1 min 15 s) cobre o tempo de a pessoa subir, pegar o microfone etc. O DJ ajusta em *Ajustes*.
- Pausar o vídeo pausa a contagem.

### Quem ainda não cantou tem preferência (rodadas)

Na noite toda não há limite de músicas, mas cada pessoa só tem **uma música na fila por vez**: depois de cantar, libera outra. Cada pedido ganha uma rodada (1ª música = rodada 1, 2ª = rodada 2...). Um pedido novo entra **depois de todos da mesma rodada e antes de quem já está numa rodada maior**.

Exemplo: a fila é `Duda (1ª) > Thiago (2ª)`. Chega a Eva pela primeira vez e a fila fica `Duda > Eva > Thiago`.

- Se o DJ reordena na mão, a escolha dele vale. Quem chega depois se encaixa respeitando o que ele fez.
- O DJ vê em cada pedido se é a "1ª vez" ou a "2ª música".
- Em **Ajustes**, o DJ pode desligar a regra e voltar para a ordem de chegada pura.
- Quem está numa rodada maior vê no celular que o horário pode mudar se chegar gente nova.

### Tocar livre (DJ)

O DJ pode tocar **qualquer coisa, a hora que quiser**: a música dele para cantar, um som de fundo enquanto vai ao banheiro, um mix entre uma música e outra. No card **Tocar livre** do painel, ele busca no YouTube ("Qualquer música" ou "Só karaokê") e aperta **Tocar agora**.

- Toca **só no player do DJ**. Não grava nada no banco, não entra na fila e **não aparece para ninguém**, nem na TV nem no celular dos clientes.
- A opção **Repetir** deixa a música em loop, bom para som de fundo.
- **Voltar para a fila** retorna o player para quem está no palco, sem dar play. **Próxima** também sai do modo livre e chama o próximo.

### "Não está aqui"

Na primeira vez, a pessoa desce 3 posições e vê um aviso no celular. Na segunda, sai da fila. Essa regra fica em `dj_not_here()` no SQL e pode ser combinada com o dono.

### Cota do YouTube

Cada busca nova gasta cerca de 101 unidades (100 da busca + 1 da duração), e a cota grátis é de 10.000 por dia, o que dá umas 100 buscas novas por dia. Por isso:

- Toda busca fica em cache por 30 dias (`search_cache`). Quando alguém procura "evidências" de novo, não gasta cota.
- Só quem está logado pode buscar.
- Se a cota acabar, o app mostra uma mensagem clara.

Se não der conta, dá para pedir aumento de cota ao Google (é gratuito, mas passa por análise).

---

## Configuração (passo a passo)

### 1. Supabase

1. Crie um projeto **novo** em [supabase.com](https://supabase.com).
2. Abra o **SQL Editor** e rode, nesta ordem, o conteúdo de `supabase/migrations/0001_init.sql` e depois o de `0002_rodadas.sql`.
3. Em **Project Settings › API**, copie a **Project URL** e a **anon public key** para `web/js/config.js`.

### 2. Login com Google

1. No [Google Cloud Console](https://console.cloud.google.com), crie um projeto. Em **APIs e serviços › Credenciais › Criar credenciais › ID do cliente OAuth**, escolha o tipo **Aplicativo da Web**.
2. Em **URIs de redirecionamento autorizados**, coloque:
   `https://SEU-PROJETO.supabase.co/auth/v1/callback`
3. No Supabase, vá em **Authentication › Sign In / Providers › Google**, ative e cole o Client ID e o Client Secret.
4. Em **Authentication › URL Configuration**, preencha:
   - **Site URL:** o endereço do site (ex.: `https://SEU-USUARIO.github.io/karaoke-fila/`)
   - **Redirect URLs:** o mesmo endereço com `**` no fim, e também `http://localhost:5500/**` para testar no computador.

### 3. Chave do YouTube

1. No mesmo projeto do Google Cloud, ative a **YouTube Data API v3**.
2. Crie uma **Chave de API** e restrinja ela à YouTube Data API v3.

### 4. Edge Function de busca

Com a [Supabase CLI](https://supabase.com/docs/guides/cli) instalada:

```bash
supabase login
supabase link --project-ref SEU-PROJECT-REF
supabase secrets set YOUTUBE_API_KEY=sua-chave-aqui
supabase functions deploy youtube-search
```

A chave do YouTube fica só no servidor, nunca no navegador.

### 5. Virar DJ

Entre uma vez no app com a conta Google do DJ. Depois, rode no SQL Editor:

```sql
update public.profiles
set role = 'dj'
where id = (select id from auth.users where email = 'email-do-dj@gmail.com');
```

### 6. Rodar e publicar

- **No computador:** abra a pasta `web` com a extensão Live Server do VS Code (porta 5500) ou rode `npx serve web`.
- **Na internet (grátis):** no GitHub, vá em **Settings › Pages › Source: GitHub Actions**. A cada push na `main`, o workflow `.github/workflows/pages.yml` publica a pasta `web/`. Isso não gasta créditos do Netlify.

Endereços:

| Tela | Endereço |
|---|---|
| Cliente | `.../index.html` (é o que o QR code abre) |
| DJ | `.../dj.html` |
| TV | `.../tv.html` (abra em tela cheia na TV do bar) |

---

## Estrutura

```
supabase/
  migrations/0001_init.sql        tabelas, segurança (RLS) e funções da fila
  migrations/0002_rodadas.sql     preferência para quem ainda não cantou
  functions/youtube-search/       busca no YouTube com cache e duração
web/
  index.html  js/app.js           cliente
  dj.html     js/dj.js            painel do DJ
  tv.html     js/tv.js            TV
  js/estimate.js                  cálculo da estimativa (função pura)
  js/supabase.js                  conexão, login, fila em tempo real
  js/config.js                    URL e chave do Supabase, nome do bar
```

## Próximos passos

- [ ] Notificação push com o celular bloqueado e o app fechado (Web Push com VAPID). Hoje o aviso funciona com o app aberto ou em segundo plano.
- [ ] Vários bares no mesmo sistema (tabela `venues`), o que abre caminho para vender a outros karaokês.
- [ ] Histórico da noite e relatório para o dono (músicas mais pedidas, horários de pico).
- [ ] Tela de administração para marcar quem é DJ sem precisar de SQL.
